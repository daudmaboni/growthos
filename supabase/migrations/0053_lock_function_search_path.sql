-- Security hardening (21 Nov 2026): pin search_path on the last three functions that didn't have one
-- (Supabase advisor "function_search_path_mutable"). They only use built-in functions, so an empty
-- search_path changes nothing about what they return.
alter function public.chat_origin(text, text) set search_path = '';
alter function kito.ws() set search_path = '';
alter function kito.mask(text) set search_path = '';
