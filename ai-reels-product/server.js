const http = require('http');
const fs = require('fs');
const path = require('path');
const { generatePdf, THEMES } = require('./pdf-generator');

const port = process.env.PORT || 3000;
const root = path.join(__dirname, 'public');
const pdfCache = new Map();

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
};

function sendPdf(res, buf, name, isPreview){
  res.writeHead(200,{
    'Content-Type':'application/pdf',
    'Content-Disposition': `${isPreview?'inline':'attachment'}; filename="${name}"`,
    'Cache-Control': isPreview ? 'public, max-age=3600' : 'private, no-store'
  });
  res.end(buf);
}

http.createServer(async (req,res)=>{
  try{
    const u = new URL(req.url, 'http://localhost');
    if(u.pathname === '/config'){
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({ checkoutUrl: process.env.CHECKOUT_URL || '' }));
    }

    const m=u.pathname.match(/^\/pdf\/([a-z-]+)\.pdf$/);
    if(m){
      const theme=m[1];
      if(!THEMES[theme]){ res.writeHead(404); return res.end('Unknown PDF style'); }
      const preview=u.searchParams.get('preview')==='1';
      if(!preview){
        const required=process.env.DOWNLOAD_KEY || '';
        const supplied=u.searchParams.get('key') || '';
        if(!required || supplied!==required){
          res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
          return res.end('Full product PDF is available after purchase.');
        }
      }
      const cacheKey=theme+':' +(preview?'preview':'full');
      let buf=pdfCache.get(cacheKey);
      if(!buf){
        buf=await generatePdf(theme,preview);
        pdfCache.set(cacheKey,buf);
      }
      return sendPdf(res,buf,`AI_Reels_Engine_Andrey_Pipeline_${theme}${preview?'_preview':''}.pdf`,preview);
    }

    const safe = u.pathname.replace(/\.\./g,'');
    let filePath = path.join(root, safe === '/' ? 'index.html' : safe);
    fs.stat(filePath, (err, stat) => {
      if(!err && stat.isDirectory()) filePath = path.join(filePath,'index.html');
      fs.readFile(filePath, (e,data)=>{
        if(e){ res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, {'Content-Type': types[path.extname(filePath)] || 'application/octet-stream'});
        res.end(data);
      });
    });
  }catch(e){
    console.error(e);
    res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'});
    res.end('Server error');
  }
}).listen(port, ()=> console.log('AI Reels Engine running on '+port));