-- Keep each person's skin when a skin's id changes.
--
-- The skin is saved on the account, and the server answers any id it no longer ships with the
-- default skin. A renamed skin would therefore drop everyone who picked it back to OpenBot's own
-- look without a word. The only ids ever saved are the ones `SKIN_IDS` has listed, and the only one
-- of those this build does not ship is the previous id of the skin now called OpenFuse, so every
-- saved id outside today's list moves to `openfuse`.
UPDATE "users"
SET "preferences" = jsonb_set("preferences", '{skin}', '"openfuse"')
WHERE "preferences" ? 'skin'
  AND "preferences"->>'skin' NOT IN ('openbot', 'openduet', 'opendots', 'openfuse');
