-- Flashcard meanings are now entered by the admin and pronunciation uses the device voice,
-- so the dictionary lookup and stored-recording schema is no longer needed.
-- Dropping these columns also drops the partial indexes built on them.
alter table deck_words
  drop column audio_id,
  drop column audio_error,
  drop column audio_url,
  drop column phonetic,
  drop column lookup_status,
  drop column lookup_error;

drop table audio_files;
drop table dictionary_cache;
