import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import { voidSentEnvelope } from "./envelopes.ts";
import { sendManualEnvelopeNudge } from "./reminders.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { createStorageService } from "./services/storage.ts";
import {
  declineSigningForToken,
  getSigningDocumentForToken,
  getSigningPayloadForToken,
  recordSignerConsent,
  SigningAccessError,
  submitSigningForToken,
} from "./signing.ts";

// What a signing link says once it no longer works, against a real
// Postgres: a link used up by signing, declining or a void names what
// happened, any other dead link has expired, and none of them opens the
// document or takes a signature. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

// A PNG of one transparent pixel, standing in for a drawn signature.
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let database: pg.Pool;
let storageDir: string;
const createdUsers: string[] = [];
// A decline and a void read their storage and email from the environment.
const settingsBefore: (readonly [string, string | undefined])[] = [];

before(async () => {
  database = await openTestDatabase();
  // The emails read the install's name through the shared pool.
  globalThis.__signudocPgPool = database;
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-spent-links-"));

  const settings = {
    EMAIL_CAPTURE_DIR: path.join(storageDir, "outbox"),
    EMAIL_DRIVER: "capture",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  };

  for (const [name, value] of Object.entries(settings)) {
    settingsBefore.push([name, process.env[name]]);
    process.env[name] = value;
  }
});

after(async () => {
  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function recordingEmailService() {
  const sent: TransactionalEmailMessage[] = [];
  const service: EmailService = {
    async send(message) {
      sent.push(message);

      return { accepted: [message.to], messageId: "m-1", rejected: [] };
    },
    async sendBatch(messages) {
      sent.push(...messages);

      return messages.map((message) => ({
        accepted: [message.to],
        messageId: "m-1",
        rejected: [],
      }));
    },
  };

  return { sent, service };
}

/**
 * An envelope out for signature with a real document behind it, waiting on
 * the first of its signers, who has agreed to sign electronically.
 */
async function createSentEnvelope({ signerCount = 1 } = {}) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const sentAt = unixNow();
  const link = await issueSigningLink({ issuedAt: sentAt });
  const storageService = createStorageService();
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const sourcePdfBytes = await sourcePdf.save();

  await storageService.putObject({
    body: sourcePdfBytes,
    contentType: "application/pdf",
    key: `test/${envelopeId}.pdf`,
  });
  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at
      ) values ($1, $2, 'Lease', 'sent', $3, 'lease.pdf', $4, 1, $5, $6, $7)
    `,
    [
      envelopeId,
      userId,
      `test/${envelopeId}.pdf`,
      sourcePdfBytes.length,
      createHash("sha256").update(sourcePdfBytes).digest("hex"),
      sentAt,
      link.exp,
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const signers: { fieldId: string; signerId: string }[] = [];

  for (let order = 1; order <= signerCount; order += 1) {
    const signerId = randomUUID();
    const fieldId = randomUUID();
    const isFirst = order === 1;

    await database.query(
      `
        insert into signers (
          id, envelope_id, name, email, sign_order, status,
          signing_token_hash, signing_token_expires_at, last_notified_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        signerId,
        envelopeId,
        isFirst ? "Riley Recipient" : "Casey Second",
        `${signerId}@example.test`,
        order,
        isFirst ? "notified" : "pending",
        isFirst ? link.tokenHash : null,
        isFirst ? link.exp : null,
        isFirst ? sentAt : null,
      ],
    );
    await database.query(
      `
        insert into fields (
          id, envelope_id, signer_id, type, page, x, y, width, height
        ) values ($1, $2, $3, 'signature', 1, 0.1, $4, 0.2, 0.1)
      `,
      [fieldId, envelopeId, signerId, 0.2 * order],
    );
    signers.push({ fieldId, signerId });
  }

  await consent(link.token);

  return { envelopeId, signers, storageService, token: link.token, userId };
}

function consent(token: string) {
  return recordSignerConsent(
    token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );
}

function submission(fieldId: string) {
  return {
    clientTimezoneOffsetMinutes: 0,
    fields: [
      {
        fieldId,
        imageDataUrl: DRAWN_SIGNATURE,
        inputMethod: "drawn",
        type: "signature",
      },
    ],
  };
}

async function readSigner(signerId: string) {
  const result = await database.query<{
    signed_at: number | null;
    signing_token_hash: string | null;
    spent_token_hash: string | null;
    status: string;
    updated_at: number;
  }>(
    `
      select signed_at, signing_token_hash, spent_token_hash, status, updated_at
      from signers
      where id = $1
    `,
    [signerId],
  );

  return result.rows[0]!;
}

async function readEnvelopeStatus(envelopeId: string) {
  const result = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.status;
}

async function auditEvents(envelopeId: string) {
  const result = await database.query<{ event: string }>(
    `select event from audit_events where envelope_id = $1 order by sequence`,
    [envelopeId],
  );

  return result.rows.map((row) => row.event);
}

/**
 * Everything a signing link can be used for is refused with `state`, and
 * leaves the envelope as it was.
 */
async function assertLinkOnlySays(
  token: string,
  state: SigningAccessError["state"],
  {
    envelopeId,
    fieldId,
    signerId,
  }: { envelopeId: string; fieldId: string; signerId: string },
) {
  const signerBefore = await readSigner(signerId);
  const statusBefore = await readEnvelopeStatus(envelopeId);
  const eventsBefore = await auditEvents(envelopeId);
  const { sent, service } = recordingEmailService();
  const refused = (error: unknown) => {
    assert.ok(error instanceof SigningAccessError);
    assert.equal(error.state, state);
    return true;
  };

  await assert.rejects(getSigningPayloadForToken(token, { database }), refused);
  await assert.rejects(
    getSigningDocumentForToken(token, { database }),
    refused,
  );
  await assert.rejects(consent(token), refused);
  await assert.rejects(
    submitSigningForToken(token, submission(fieldId), {
      database,
      emailService: service,
    }),
    refused,
  );
  await assert.rejects(
    declineSigningForToken(token, { reason: "Changed my mind." }, { database }),
    refused,
  );

  assert.deepEqual(await readSigner(signerId), signerBefore);
  assert.equal(await readEnvelopeStatus(envelopeId), statusBefore);
  assert.deepEqual(await auditEvents(envelopeId), eventsBefore);
  assert.deepEqual(sent, []);
}

test("a link opened again after signing says the signer already signed", async () => {
  const envelope = await createSentEnvelope({ signerCount: 2 });
  const [riley, casey] = envelope.signers;
  const { sent, service } = recordingEmailService();

  await submitSigningForToken(envelope.token, submission(riley!.fieldId), {
    database,
    emailService: service,
    storageService: envelope.storageService,
  });

  const signed = await readSigner(riley!.signerId);

  // The link is used up: it no longer finds the signer it was sent to.
  assert.equal(signed.status, "signed");
  assert.equal(signed.signing_token_hash, null);
  assert.equal(signed.spent_token_hash, hashOpaqueToken(envelope.token));

  // While the envelope waits on the next signer, and once it is complete.
  await assertLinkOnlySays(envelope.token, "already-signed", {
    envelopeId: envelope.envelopeId,
    ...riley!,
  });

  const caseyToken = sent
    .find((message) => message.template === "signing_invitation")
    ?.textBody.match(/\/sign\/([\w.-]+)/)?.[1];

  assert.ok(caseyToken);
  await consent(caseyToken);
  await submitSigningForToken(caseyToken, submission(casey!.fieldId), {
    database,
    emailService: service,
    storageService: envelope.storageService,
  });

  assert.equal(await readEnvelopeStatus(envelope.envelopeId), "completed");

  for (const [token, signer] of [
    [envelope.token, riley!],
    [caseyToken, casey!],
  ] as const) {
    await assertLinkOnlySays(token, "already-signed", {
      envelopeId: envelope.envelopeId,
      ...signer,
    });
  }
});

test("a link opened again after declining says the envelope was declined", async () => {
  const envelope = await createSentEnvelope();
  const [riley] = envelope.signers;

  await declineSigningForToken(
    envelope.token,
    { reason: "Not what we agreed." },
    { database },
  );

  const declined = await readSigner(riley!.signerId);

  assert.equal(declined.status, "declined");
  assert.equal(declined.signing_token_hash, null);
  await assertLinkOnlySays(envelope.token, "declined", {
    envelopeId: envelope.envelopeId,
    ...riley!,
  });
});

test("a link opened after a void says the envelope was voided", async () => {
  const envelope = await createSentEnvelope({ signerCount: 2 });
  const [riley, casey] = envelope.signers;
  const { sent, service } = recordingEmailService();

  await submitSigningForToken(envelope.token, submission(riley!.fieldId), {
    database,
    emailService: service,
    storageService: envelope.storageService,
  });

  const caseyToken = sent
    .find((message) => message.template === "signing_invitation")
    ?.textBody.match(/\/sign\/([\w.-]+)/)?.[1];

  assert.ok(caseyToken);
  await consent(caseyToken);
  await voidSentEnvelope(
    envelope.userId,
    envelope.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database },
  );

  assert.equal(await readEnvelopeStatus(envelope.envelopeId), "voided");
  assert.equal((await readSigner(casey!.signerId)).signing_token_hash, null);

  // The one who had signed and the one whose turn it was are told the same.
  for (const [token, signer] of [
    [envelope.token, riley!],
    [caseyToken, casey!],
  ] as const) {
    await assertLinkOnlySays(token, "voided", {
      envelopeId: envelope.envelopeId,
      ...signer,
    });
  }
});

test("a link that was never sent, or was replaced by a reminder, has expired", async () => {
  const envelope = await createSentEnvelope();
  const [riley] = envelope.signers;
  const unknown = await issueSigningLink();
  const { sent, service } = recordingEmailService();

  await assertLinkOnlySays(unknown.token, "expired", {
    envelopeId: envelope.envelopeId,
    ...riley!,
  });

  await sendManualEnvelopeNudge(
    envelope.userId,
    envelope.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database, emailService: service },
  );

  const newToken = sent[0]?.textBody.match(/\/sign\/([\w.-]+)/)?.[1];

  assert.ok(newToken);
  assert.notEqual(newToken, envelope.token);
  await assertLinkOnlySays(envelope.token, "expired", {
    envelopeId: envelope.envelopeId,
    ...riley!,
  });

  // The replaced link stays expired once the new one has been used.
  await submitSigningForToken(newToken, submission(riley!.fieldId), {
    database,
    emailService: service,
    storageService: envelope.storageService,
  });

  await assertLinkOnlySays(envelope.token, "expired", {
    envelopeId: envelope.envelopeId,
    ...riley!,
  });
  await assertLinkOnlySays(newToken, "already-signed", {
    envelopeId: envelope.envelopeId,
    ...riley!,
  });
});
