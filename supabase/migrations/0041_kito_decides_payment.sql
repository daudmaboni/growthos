-- "Says they paid — check your money" is decided by Kito reading the chat, not by word rules.
-- A word-rule hit (payment_signal) now only makes Kito read that chat first; the Check payment
-- list and its counts use Kito's verdict (sold, not low confidence) or the owner's ✅ name mark.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.chat_counts(uuid,text)'::regprocedure);
  d := replace(d, '(payment_signal or kito_outcome = ''sold'' or outcome_override = ''sold'')',
                  '((kito_outcome = ''sold'' and kito_confidence is distinct from ''low'') or outcome_override = ''sold'')');
  execute d;

  d := pg_get_functiondef('public.needs_attention(uuid)'::regprocedure);
  d := replace(d, '(c.payment_signal or c.kito_outcome = ''sold'' or c.outcome_override = ''sold'')',
                  '((c.kito_outcome = ''sold'' and c.kito_confidence is distinct from ''low'') or c.outcome_override = ''sold'')');
  d := replace(d, 'when c.payment_signal then ''rules'' ', '');
  execute d;
end
$mig$;
