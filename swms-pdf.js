import { PDFDocument, PDFTextField } from 'pdf-lib';

const fields = {
  Project: (_, job) => job,
  'Principal Contractor': details => details.contractor,
  Site: details => details.site,
  'Site Manager': details => details.supervisor,
  'Date and Version': (details, _, version) => `${details.date || ''} / v${version}`,
  'Emergency and Assembly Point': details => details.emergency,
  'New Hazard 1 - Hazard Change': details => details.hazards,
  'New Hazard 1 - Additional Controls': details => details.controls
};

function textField(form, name) {
  const field = form.getFieldMaybe(name);
  return field instanceof PDFTextField ? field : undefined;
}

export async function completedSwmsPdf(source, job, version, details, signatures) {
  const pdf = await PDFDocument.load(source);
  const form = pdf.getForm();
  if (!Object.keys(fields).every(name => textField(form, name)) ||
      ![1,2,3,4,5,6,7,8].every(n => ['Name Role','Signature','Date'].every(label => textField(form, `Worker ${n} - ${label}`)))) {
    return null;
  }
  for (const [name, value] of Object.entries(fields)) {
    textField(form, name).setText(value(details, job, version) || '');
  }
  const signedAt = value => new Intl.DateTimeFormat('en-AU',{
    timeZone:'Australia/Melbourne',dateStyle:'short',timeStyle:'short'
  }).format(new Date(value.replace(' ','T')+'Z'));
  for (const [index, worker] of signatures.entries()) {
    const png = await pdf.embedPng(Buffer.from(worker.signature.split(',')[1], 'base64'));
    if (index < 8) {
      const prefix = `Worker ${index+1} - `;
      textField(form, prefix+'Name Role').setText(worker.name+' / '+worker.role);
      textField(form, prefix+'Date').setText(signedAt(worker.signed_at));
      textField(form, prefix+'Signature').setImage(png);
    } else {
      const page = pdf.addPage();
      page.drawText('SWMS worker sign-off continuation', {x:40,y:790,size:18});
      page.drawText(`Version ${version} | ${worker.name} / ${worker.role}`,{x:40,y:755,size:12});
      page.drawText(signedAt(worker.signed_at),{x:40,y:730,size:12});
      const size=png.scaleToFit(240,90);
      page.drawImage(png,{x:40,y:620,...size});
    }
  }
  form.flatten();
  return pdf.save();
}
