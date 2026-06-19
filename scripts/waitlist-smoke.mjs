import { createClient } from '@supabase/supabase-js'
const c = createClient('https://xyahxwtxwspqpeuvoeak.supabase.co','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5YWh4d3R4d3NwcXBldXZvZWFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjY1MDcsImV4cCI6MjA5NzQ0MjUwN30.jXnf5BmlhuJX5ZnjN5_Fjq7V40-ldEz9tF5hSSmbeVI',{auth:{persistSession:false}})
const t=Date.now()
const good = await c.from('waitlist').insert({ email:`test+${t}@example.com`, source:'smoke' })
console.log('anon insert (valid email):', good.error? '❌ '+good.error.message : '✅')
const bad = await c.from('waitlist').insert({ email:'not-an-email', source:'smoke' })
console.log('invalid email rejected:', bad.error? '✅' : '❌ ALLOWED')
const read = await c.from('waitlist').select('*').limit(1)
console.log('anon read blocked:', (read.data||[]).length===0? '✅ (0 rows, write-only)' : '❌ LEAK')
