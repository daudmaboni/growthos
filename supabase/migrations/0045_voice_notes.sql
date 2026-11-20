-- Voice notes: save WhatsApp audio in the same private bucket so it can be played in Chats.
-- WhatsApp voice notes are audio/ogg (Opus); forwarded audio files can be mp3, m4a, aac or amr.
update storage.buckets
set allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf',
  'audio/ogg','audio/opus','audio/mpeg','audio/mp4','audio/aac','audio/amr','audio/webm']
where id = 'wa-media';
