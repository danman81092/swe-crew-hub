import crypto from 'node:crypto';

const callback = 'https://swe-crew-hub.onrender.com/api/xero/callback';
const origin = new URL(callback).origin;
const draftContactName = 'SWE Draft – Select Customer';

const salesAccount = '195';
const taxType = 'OUTPUT';

export function draftTotals(lines) {
  const amounts = lines.map(line => Math.round((line.quantity * line.rate + Number.EPSILON) * 100));
  const subtotal = amounts.reduce((total, cents) => total + cents, 0);
  const gst = amounts.reduce((total, cents) => total + Math.round(cents / 10), 0);
  return {subtotal:subtotal / 100, gst:gst / 100, total:(subtotal + gst) / 100};
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0,10) === value;
}

export function buildDraft(costing, {from,to,includeExtras}) {
  if (!validDate(from) || !validDate(to) || from > to) throw Error('Choose a valid billing period.');
  if (from < costing.job.start_day) throw Error('Start the billing period on or after the project costing start date.');
  const grouped = new Map();
  const pending = costing.lines.filter(line => line.day >= from && line.day <= to);
  for (const line of pending) {
    if (line.kind === 'extra' ? !includeExtras : !['submitted','approved'].includes(line.status)) continue;
    const extra = line.kind === 'extra';
    const qty = extra ? 1 : line.qty;
    const rate = extra ? line.amount : line.rate;
    if (line.amount == null || !Number.isFinite(rate) || !Number.isFinite(qty) || qty <= 0) {
      throw Error('Complete the rate and quantity for '+line.name+' on '+line.day+'.');
    }
    const name = line.name.trim();
    const key = JSON.stringify([line.kind,name.toLowerCase(),line.unit,rate]);
    if (!grouped.has(key)) grouped.set(key,{description:name+(line.unit?' ('+line.unit+')':''),quantity:0,rate});
    grouped.get(key).quantity += qty;
  }
  const lines = [...grouped.values()].map(line=>({...line,quantity:Number(line.quantity.toFixed(4))}));
  if (!lines.length) throw Error('There are no submitted or approved invoice lines in that period.');
  if (lines.some(line=>line.quantity<=0)) throw Error('A quantity is too small to invoice in Xero.');
  return {lines,excluded:pending.filter(line=>['draft','returned'].includes(line.status)).length};
}

export function registerXero({app,db,auth,manager,readJobCosting}) {
  const clientId = process.env.XERO_CLIENT_ID;
  const secret = process.env.XERO_CLIENT_SECRET;
  const configured = Boolean(clientId && secret);
  const key = configured ? crypto.createHash('sha256').update('swe-xero-token:'+secret).digest() : null;
  db.exec(`
    CREATE TABLE IF NOT EXISTS xero_oauth_state (state TEXT PRIMARY KEY, actor INTEGER NOT NULL, session TEXT NOT NULL, expiry INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS xero_connection (id INTEGER PRIMARY KEY CHECK(id=1), encrypted TEXT NOT NULL, tenant TEXT);
    CREATE TABLE IF NOT EXISTS xero_draft_requests (
      id TEXT PRIMARY KEY, job INTEGER NOT NULL, start_day TEXT NOT NULL, end_day TEXT NOT NULL,
      status TEXT NOT NULL, invoice_id TEXT, invoice_number TEXT
    );
  `);
  const connection = () => db.prepare('SELECT * FROM xero_connection WHERE id=1').get();
  const sessionHash = req => crypto.createHash('sha256').update(req.headers.cookie?.match(/(?:^|;\s*)swe_session=([^;]+)/)?.[1]||'').digest('hex');
  const seal = value => {
    const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
  };
  const unseal = value => {
    const bytes=Buffer.from(value,'base64');
    const cipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
    cipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));
  };
  async function request(url,options) {
    const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
    const body=await response.json().catch(()=>null);
    if (!response.ok || !body) {
      const error=Error('Xero returned an error ('+response.status+').');
      error.status=response.status;
      throw error;
    }
    return body;
  }
  async function token(params) {
    const value=await request('https://identity.xero.com/connect/token',{
      method:'POST',
      headers:{Authorization:'Basic '+Buffer.from(clientId+':'+secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams(params)
    });
    if (!value.access_token || !value.refresh_token || !Number.isFinite(value.expires_in)) throw Error('Xero did not return a usable connection.');
    return {access:value.access_token,refresh:value.refresh_token,expiry:Date.now()+value.expires_in*1000};
  }
  let refresh;
  async function access() {
    if (!configured || !connection()) throw Error('Connect Xero first.');
    let current;
    try { current=unseal(connection().encrypted); } catch { throw Error('Reconnect Xero after changing credentials.'); }
    if (current.expiry>Date.now()+60000) return current.access;
    if (!refresh) {
      const previous=connection().encrypted;
      refresh=token({grant_type:'refresh_token',refresh_token:current.refresh}).then(next=>{
        if (!db.prepare('UPDATE xero_connection SET encrypted=? WHERE id=1 AND encrypted=?').run(seal(next),previous).changes) throw Error('The Xero connection changed. Try again.');
        return next.access;
      }).finally(()=>{refresh=null});
    }
    return refresh;
  }
  async function organisations(accessToken) {
    const rows=await request('https://api.xero.com/connections',{headers:{Authorization:'Bearer '+accessToken}});
    return rows.filter(row=>row.tenantType==='ORGANISATION').map(row=>({id:row.tenantId,name:row.tenantName}));
  }
  async function accounting(endpoint,options={}) {
    const tenant=connection()?.tenant;
    if (!tenant) throw Error('Select your Xero organisation first.');
    const accessToken=await access();
    if (connection()?.tenant!==tenant) throw Error('The Xero organisation changed. Load the preview again.');
    return request('https://api.xero.com/api.xro/2.0/'+endpoint,{
      ...options,headers:{Authorization:'Bearer '+accessToken,'Xero-tenant-id':tenant,Accept:'application/json',...options.headers}
    });
  }
  const handle = fn => async (req,res) => {
    res.set('Cache-Control','no-store');
    try { await fn(req,res); }
    catch (error) {
      const message=error.status===401?'Xero authorisation expired. Reconnect Xero and try again.':error.message;
      res.status(400).json({error:message});
    }
  };
  app.get('/api/xero/status',auth,manager,handle((req,res)=>{
    res.json({configured,connected:configured&&Boolean(connection()),tenant:connection()?.tenant??null});
  }));
  app.post('/api/xero/connect',auth,manager,handle((req,res)=>{
    if (!configured) throw Error('The Xero credentials are missing from the Crew Hub service.');
    const now=Date.now();
    db.prepare('DELETE FROM xero_oauth_state WHERE expiry<=?').run(now);
    const state=crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO xero_oauth_state VALUES (?,?,?,?)').run(state,req.user.id,sessionHash(req),now+600000);
    const query=new URLSearchParams({client_id:clientId,redirect_uri:callback,response_type:'code',state,
      scope:'offline_access accounting.invoices accounting.contacts.read accounting.settings.read'});
    res.json({url:'https://login.xero.com/identity/connect/authorize?'+query});
  }));
  // Return to the Crew Hub origin before using its strictly same-site session cookie.
  app.get('/api/xero/callback',(req,res)=>{
    const nonce=crypto.randomBytes(16).toString('base64');
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; connect-src 'self'; frame-ancestors 'none'"});
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8">
      <title>Connecting Xero</title><p>Finishing your Xero connection…</p>
      <noscript>Enable JavaScript and reconnect from Crew Hub.</noscript>
      <script nonce="${nonce}">
      const params = new URLSearchParams(location.search);
      history.replaceState(null,'',location.pathname);
      fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({state:params.get('state'),code:params.get('code')})})
        .then(response=>location.replace(response.ok?'/?xero=connected':'/?xero=failed'))
        .catch(()=>location.replace('/?xero=failed'));
      </script></html>`);
  });
  app.post('/api/xero/callback',auth,manager,handle(async(req,res)=>{
    const {state,code}=req.body;
    const valid=req.get('Origin')===origin&&configured&&typeof state==='string'&&
      db.prepare('DELETE FROM xero_oauth_state WHERE state=? AND actor=? AND session=? AND expiry>?').run(state,req.user.id,sessionHash(req),Date.now()).changes;
    if (!valid || typeof code!=='string') throw Error('Restart the connection from Crew Hub.');
    const credentials=await token({grant_type:'authorization_code',code,redirect_uri:callback});
    const tenants=await organisations(credentials.access);
    if (!tenants.length) throw Error('No Xero organisations authorised.');
    const existing=connection()?.tenant;
    const tenant=tenants.some(item=>item.id===existing)?existing:null;
    db.prepare('INSERT INTO xero_connection VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted,tenant=excluded.tenant').run(seal(credentials),tenant);
    res.json({ok:true});
  }));
  app.get('/api/xero/organisations',auth,manager,handle(async(req,res)=>res.json(await organisations(await access()))));
  app.post('/api/xero/organisation',auth,manager,handle(async(req,res)=>{
    const choices=await organisations(await access());
    const match=choices.find(choice=>choice.id===req.body.id);
    if (!match) throw Error('Select an authorised Xero organisation.');
    db.prepare('UPDATE xero_connection SET tenant=? WHERE id=1').run(match.id);
    res.json(match);
  }));
  async function preview(req) {
    const tenant=connection()?.tenant;
    if (!configured || !tenant || req.body.tenant!==tenant) throw Error('Select your Xero organisation first.');
    const costing=readJobCosting(req.params.id);
    const previous=db.prepare("SELECT MAX(end_day) AS through FROM xero_draft_requests WHERE job=? AND status='created'").get(costing.job.id).through;
    const dates=costing.lines.filter(line=>line.day>=costing.job.start_day&&(!previous||line.day>previous)&&
      (line.kind==='extra'||['submitted','approved'].includes(line.status))).map(line=>line.day).sort();
    if (!dates.length) throw Error(previous?'No new eligible work after '+previous+'. Check Xero for the earlier draft.':'No submitted or approved work is available for a draft.');
    const from=dates[0],to=dates.at(-1);
    const draft=buildDraft(costing,{from,to,includeExtras:true});
    const query=new URLSearchParams({where:'Name=="'+draftContactName+'"'});
    const data=await accounting('Contacts?'+query);
    const contact=data.Contacts?.find(item=>item.Name===draftContactName&&item.ContactStatus==='ACTIVE');
    if (!contact?.ContactID) throw Error('Create the one-time Xero contact "'+draftContactName+'" and try again.');
    if (connection()?.tenant!==tenant) throw Error('The Xero organisation changed. Open the preview again.');
    const invoice={Type:'ACCREC',Status:'DRAFT',Contact:{ContactID:contact.ContactID},
      LineAmountTypes:'Exclusive',Reference:(costing.job.name+' | '+from+' to '+to).slice(0,255),
      LineItems:draft.lines.map(line=>({Description:line.description,Quantity:line.quantity,UnitAmount:line.rate,AccountCode:salesAccount,TaxType:taxType}))};
    const proof=crypto.createHmac('sha256',key).update(JSON.stringify([req.user.id,tenant,costing.job.id,from,to,invoice])).digest('hex');
    return {...draft,proof,invoice,tenant,from,to,job:costing.job.id,previous};
  }
  app.post('/api/xero/job/:id/preview',auth,manager,handle(async(req,res)=>{
    const {lines,excluded,proof,invoice,previous}=await preview(req);
    res.json({lines,excluded,proof,reference:invoice.Reference,previous,totals:draftTotals(lines)});
  }));
  const reserve=db.transaction((draft,id)=>{
    const existing=db.prepare('SELECT * FROM xero_draft_requests WHERE job=? AND start_day<=? AND end_day>=? AND status<>?').get(draft.job,draft.to,draft.from,'failed');
    if (existing) {
      if (existing.id===id && existing.status==='created') return existing;
      throw Error(existing.status==='created'
        ?'This billing period overlaps an existing Xero draft '+(existing.invoice_number||'')+'.'
        :'A previous request for this period is unresolved. Check Xero before attempting another draft.');
    }
    db.prepare('INSERT INTO xero_draft_requests (id,job,start_day,end_day,status) VALUES (?,?,?,?,?)').run(id,draft.job,draft.from,draft.to,'pending');
    return null;
  });
  app.post('/api/xero/job/:id/draft',auth,manager,handle(async(req,res)=>{
    if (req.get('Origin')!==origin) throw Error('Open the live Crew Hub to create a draft.');
    const existing=typeof req.body.proof==='string'&&db.prepare("SELECT invoice_id,invoice_number FROM xero_draft_requests WHERE id=? AND job=? AND status='created'").get(req.body.proof,Number(req.params.id));
    if (existing) return res.json({invoiceId:existing.invoice_id,invoiceNumber:existing.invoice_number});
    const draft=await preview(req);
    if (req.body.proof!==draft.proof) throw Error('The preview or connection changed. Review the invoice again.');
    const id=draft.proof;
    await access();
    if (connection()?.tenant!==draft.tenant) throw Error('The Xero organisation changed. Load the preview again.');
    const prior=reserve.immediate(draft,id);
    if (prior) return res.json({invoiceId:prior.invoice_id,invoiceNumber:prior.invoice_number});
    try {
      const data=await accounting('Invoices',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':id},body:JSON.stringify({Invoices:[draft.invoice]})});
      const result=data.Invoices?.[0];
      if (!result?.InvoiceID || result.Status!=='DRAFT' || result.HasErrors) throw Error('Xero did not confirm a draft.');
      db.prepare("UPDATE xero_draft_requests SET status='created',invoice_id=?,invoice_number=? WHERE id=?").run(result.InvoiceID,result.InvoiceNumber||null,id);
      res.json({invoiceId:result.InvoiceID,invoiceNumber:result.InvoiceNumber});
    } catch (error) {
      if ([400,401,403,404,429].includes(error.status)) {
        db.prepare("DELETE FROM xero_draft_requests WHERE id=? AND status='pending'").run(id);
        throw Error(error.status===400?'Xero rejected the invoice. Check the customer, sales account and invoice lines.':error.message);
      }
      throw Error('Xero did not confirm the draft. Check Xero before creating another invoice for this period.');
    }
  }));
}
