export const swmsFields = ['site','contractor','date','supervisor','emergency','hazards','controls'];

export function registerJobSwms({app,db,auth,manager,fail}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_swms (
      id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES catalog(id),
      document_id INTEGER NOT NULL REFERENCES swms_documents(id),
      required INTEGER NOT NULL, assigned_by INTEGER NOT NULL REFERENCES users(id),
      UNIQUE(job_id,document_id)
    );
    CREATE TABLE IF NOT EXISTS job_swms_versions (
      assignment_id INTEGER NOT NULL REFERENCES job_swms(id),
      version INTEGER NOT NULL, details TEXT NOT NULL,
      saved_by INTEGER NOT NULL REFERENCES users(id),
      saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(assignment_id,version)
    );
    CREATE TABLE IF NOT EXISTS job_swms_workers (
      assignment_id INTEGER NOT NULL REFERENCES job_swms(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY(assignment_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS job_swms_signatures (
      assignment_id INTEGER NOT NULL, version INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, role TEXT NOT NULL, signature TEXT NOT NULL,
      signed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(assignment_id,version,user_id),
      FOREIGN KEY(assignment_id,version) REFERENCES job_swms_versions(assignment_id,version)
    );
  `);
  const select='SELECT a.id,a.job_id,a.document_id,a.required,d.title,c.name AS job FROM job_swms a JOIN catalog c ON c.id=a.job_id JOIN swms_documents d ON d.id=a.document_id';
  const assignment=id=>{
    const row=db.prepare(select+' WHERE a.id=?').get(id);
    if(!row)throw Error('Assigned SWMS not found.');
    return row;
  };
  const latest=id=>db.prepare('SELECT version,details FROM job_swms_versions WHERE assignment_id=? ORDER BY version DESC LIMIT 1').get(id);
  const pendingWorkers=id=>db.prepare('SELECT u.id,u.name FROM job_swms_workers w JOIN users u ON u.id=w.user_id WHERE w.assignment_id=? ORDER BY u.name').all(id);
  const signatures=(id,version,viewer)=>db.prepare(`SELECT user_id,name,role,signed_at,
    CASE WHEN ? OR user_id=? THEN signature END AS signature FROM job_swms_signatures
    WHERE assignment_id=? AND version=? ORDER BY signed_at,user_id`).all(viewer.role==='manager'?1:0,viewer.id,id,version);
  const summary=(row,viewer)=>{
    const current=latest(row.id);
    const workers=pendingWorkers(row.id);
    const signed=current?signatures(row.id,current.version,viewer):[];
    const missing=workers.filter(worker=>!signed.some(person=>person.user_id===worker.id));
    const details=current?JSON.parse(current.details):{};
    let status='Not started';
    if(current){
      if(!complete(details))status='Details required';
      else if(current.version>1&&!signed.length)status='Review required';
      else status=signed.length&&!missing.length?'Current':'Awaiting signatures';
    }
    return {...row,status,version:current?.version||0,details,workers,missing,signed};
  };
  function complete(details){return details.site&&details.date&&details.supervisor&&details.emergency}
  const route=fn=>(req,res)=>{
    res.set('Cache-Control','no-store');
    try{fn(req,res)}catch(error){fail(res,error)}
  };
  app.get('/api/job-swms',auth,route((req,res)=>{
    const rows=db.prepare(select+' ORDER BY c.name COLLATE NOCASE,d.title COLLATE NOCASE').all();
    res.json(rows.map(row=>{
      const {status,version}=summary(row,req.user);
      return {...row,status,version};
    }));
  }));
  const start=db.transaction((jobId,documentId,required,userId,projectName)=>{
    if(projectName!==undefined){
      if(jobId!==undefined||typeof projectName!=='string')throw Error('Enter a project name.');
      const name=projectName.trim().replace(/\s+/g,' ');
      if(!name||name.length>200)throw Error('Enter a project name of up to 200 characters.');
      const existing=db.prepare("SELECT id,active,name FROM catalog WHERE kind='job' ORDER BY active DESC,id").all()
        .find(job=>job.name.trim().replace(/\s+/g,' ').toLowerCase()===name.toLowerCase());
      if(existing&&!existing.active)throw Error('That project is archived. Ask the office to restore it.');
      jobId=existing?.id??Number(db.prepare("INSERT INTO catalog(kind,name) VALUES ('job',?)").run(name).lastInsertRowid);
    }
    if(!Number.isSafeInteger(jobId)||!Number.isSafeInteger(documentId))throw Error('Select a project and SWMS.');
    if(!db.prepare("SELECT id FROM catalog WHERE id=? AND kind='job' AND active=1").get(jobId??null))throw Error('Select an active job.');
    if(!db.prepare('SELECT id FROM swms_documents WHERE id=? AND deleted_at IS NULL').get(documentId??null))throw Error('Select an available SWMS.');
    db.prepare('INSERT INTO job_swms(job_id,document_id,required,assigned_by) VALUES (?,?,?,?) ON CONFLICT(job_id,document_id) DO UPDATE SET required=1 WHERE excluded.required=1').run(jobId,documentId,required?1:0,userId);
    return db.prepare('SELECT id FROM job_swms WHERE job_id=? AND document_id=?').get(jobId,documentId);
  });
  app.post('/api/job-swms',auth,manager,route((req,res)=>{
    const {jobId,documentId,required,projectName}=req.body;
    res.json(start.immediate(jobId,documentId,required===true,req.user.id,projectName));
  }));
  app.post('/api/job-swms/start',auth,route((req,res)=>{
    const {jobId,documentId,projectName}=req.body;
    res.json(start.immediate(jobId,documentId,false,req.user.id,projectName));
  }));
  app.get('/api/job-swms/:id',auth,route((req,res)=>{
    const row=assignment(req.params.id);
    const record=summary(row,req.user);
    const versions=db.prepare('SELECT version,details,saved_at FROM job_swms_versions WHERE assignment_id=? ORDER BY version DESC').all(row.id)
      .map(item=>({...item,details:JSON.parse(item.details),signed:signatures(row.id,item.version,req.user)}));
    res.json({...record,versions});
  }));
  app.get('/api/job-swms/:id/master',auth,route((req,res)=>{
    const row=assignment(req.params.id);
    const item=db.prepare('SELECT d.pdf FROM job_swms a JOIN swms_documents d ON d.id=a.document_id WHERE a.id=?').get(row.id);
    res.set({'Content-Disposition':'inline','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});
    res.type('application/pdf').send(Buffer.from(item.pdf,'base64'));
  }));
  const save=db.transaction((id,base,details,user)=>{
    const current=latest(id);
    if((current?.version||0)!==base)throw Error('Someone has updated this SWMS. Reopen it before saving.');
    const json=JSON.stringify(details);
    if(current?.details===json)return;
    db.prepare('INSERT INTO job_swms_versions(assignment_id,version,details,saved_by) VALUES (?,?,?,?)').run(id,base+1,json,user);
  });
  app.put('/api/job-swms/:id/details',auth,route((req,res)=>{
    const row=assignment(req.params.id);
    const {version,details}=req.body;
    if(!Number.isInteger(version)||!details||Array.isArray(details))throw Error('Invalid SWMS details.');
    const fields=Object.fromEntries(swmsFields.map(key=>{
      const value=details[key]??'';
      if(typeof value!=='string'||value.length>3000)throw Error('Keep each field under 3,000 characters.');
      return [key,value.trim()];
    }));
    if(fields.date&&(!/^\d{4}-\d{2}-\d{2}$/.test(fields.date)||!Number.isFinite(Date.parse(fields.date))||new Date(fields.date).toISOString().slice(0,10)!==fields.date))throw Error('Choose a valid work date.');
    save.immediate(row.id,version,fields,req.user.id);
    res.json({ok:true});
  }));
  app.post('/api/job-swms/:id/workers',auth,manager,route((req,res)=>{
    const row=assignment(req.params.id);
    const user=db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='employee'").get(req.body.userId??null);
    if(!user)throw Error('Select an active worker.');
    db.prepare('INSERT OR IGNORE INTO job_swms_workers VALUES (?,?)').run(row.id,user.id);
    res.json({ok:true});
  }));
  const sign=db.transaction((id,version,role,signature,user)=>{
    const current=latest(id);
    if(!current||current.version!==version)throw Error('The SWMS has changed. Reopen and review the current version.');
    if(!complete(JSON.parse(current.details)))throw Error('Complete the site, date, supervisor and emergency details first.');
    db.prepare('INSERT OR IGNORE INTO job_swms_signatures(assignment_id,version,user_id,name,role,signature) VALUES (?,?,?,?,?,?)')
      .run(id,version,user.id,user.name,role,signature);
    if(user.role==='employee')db.prepare('INSERT OR IGNORE INTO job_swms_workers VALUES (?,?)').run(id,user.id);
  });
  app.post('/api/job-swms/:id/sign',auth,route((req,res)=>{
    const row=assignment(req.params.id);
    const {version,role,signature,reviewed}=req.body;
    if(reviewed!==true||!Number.isInteger(version)||typeof role!=='string'||!role.trim()||role.length>100||
       typeof signature!=='string'||signature.length>1000000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)){
      throw Error('Enter your work role and draw your signature.');
    }
    sign.immediate(row.id,version,role.trim(),signature,req.user);
    res.json({ok:true});
  }));
}
