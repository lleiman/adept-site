const http=require('http');
const fs=require('fs');
const path=require('path');
const {generatePdf}=require('./pdf-generator');
const port=process.env.PORT||3000;
const root=path.join(__dirname,'public');
let pdfCache=null;
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf'};
async function productPdf(res,download){
  if(!pdfCache) pdfCache=await generatePdf('original',false);
  res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':(download?'attachment':'inline')+'; filename="AI_Reels_Engine_Creative_Pipeline_RU.pdf"','Cache-Control':'public, max-age=3600'});
  res.end(pdfCache);
}
http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/product.pdf') return await productPdf(res,false);
  if(u.pathname==='/download.pdf') return await productPdf(res,true);
  const safe=u.pathname.replace(/\.\./g,'');
  let filePath=path.join(root,safe==='/'?'index.html':safe);
  fs.stat(filePath,(err,stat)=>{
   if(!err&&stat.isDirectory()) filePath=path.join(filePath,'index.html');
   fs.readFile(filePath,(e,data)=>{
    if(e){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Не найдено');}
    res.writeHead(200,{'Content-Type':types[path.extname(filePath)]||'application/octet-stream'});
    res.end(data);
   });
  });
 }catch(e){console.error(e);res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});res.end('Ошибка сервера');}
}).listen(port,()=>console.log('AI Reels Engine RU running on '+port));