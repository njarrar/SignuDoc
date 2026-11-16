-- A signing link stops working when its signer signs or declines, or when
-- the envelope is voided: signers.signing_token_hash is cleared, so the link
-- no longer finds a signer. That left nothing to tell such a link from one
-- that never existed, and a signer who opened theirs again was told it had
-- expired.
--
-- * signers.spent_token_hash: the hash of the link that was used up. It is
--   read only to choose what the signing page says (already signed,
--   declined or voided) and never gives access to the document. A link
--   replaced by a newer one (a reminder) is not kept, and still reads as
--   expired.

alter table public.signers
  add column if not exists spent_token_hash text;

create index if not exists idx_signers_spent_token_hash
  on public.signers(spent_token_hash)
  where spent_token_hash is not null;
