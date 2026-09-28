const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 3000;
const root = path.join(__dirname, 'public');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

http.createServer((req,res)=>{
  if(req.url === '/config'){
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
    return res.end(JSON.stringify({ checkoutUrl: process.env.CHECKOUT_URL || '' }));
  }
  const safe = req.url.split('?')[0].replace(/\.\./g,'');
  let filePath = path.join(root, safe === '/' ? 'index.html' : safe);
  fs.stat(filePath, (err, stat) => {
    if(!err && stat.isDirectory()) filePath = path.join(filePath,'index.html');
    fs.readFile(filePath, (e,data)=>{
      if(e){ res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {'Content-Type': types[path.extname(filePath)] || 'application/octet-stream'});
      res.end(data);
    });
  });
}).listen(port, ()=> console.log('AI Reels Engine running on '+port));