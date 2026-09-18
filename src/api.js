import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || 'https://glgvvywkhelpydodxajw.supabase.co',
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_MibwcPvzQ-IcbFJtnXGUgg_ZNVrPPEk'
);
export async function result(request) {
 const {data,error}=await request;
 if(error) throw error;
 return data;
}
export async function allRows(table,configure=q=>q) {
 const rows=[];
 for(let offset=0;;offset+=500){
  const page=await result(configure(supabase.from(table).select('*')).range(offset,offset+499));
  rows.push(...page);
  if(page.length<500) return rows;
 }
}
