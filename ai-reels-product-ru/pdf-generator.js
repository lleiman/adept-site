const pdfMake = require('pdfmake/build/pdfmake');
const vfsFonts = require('pdfmake/build/vfs_fonts');
const data = require('./pdf-data');

pdfMake.vfs = vfsFonts.pdfMake ? vfsFonts.pdfMake.vfs : vfsFonts;

const THEMES = {
  original:{bg:'#FFFFFF',fg:'#111111',muted:'#737373',accent:'#111111',panel:'#F6F6F6',display:'Original'},
  editorial:{bg:'#F2EEE5',fg:'#181818',muted:'#716B62',accent:'#181818',panel:'#E8E1D5',display:'Editorial'},
  case:{bg:'#0B0B0B',fg:'#F4F4EF',muted:'#858585',accent:'#F4F4EF',panel:'#151515',display:'Case Study'},
  zine:{bg:'#F3EF22',fg:'#070707',muted:'#262626',accent:'#FF5CAC',panel:'#FFFFFF',display:'Internet Zine'},
  fashion:{bg:'#ECE8E0',fg:'#111111',muted:'#756F66',accent:'#111111',panel:'#D9D2C8',display:'Fashion'},
  manual:{bg:'#D9DDD4',fg:'#172019',muted:'#455047',accent:'#172019',panel:'#E9ECE6',display:'Field Manual'},
  social:{bg:'#F3F3F3',fg:'#111111',muted:'#737373',accent:'#111111',panel:'#FFFFFF',display:'Social'},
  swiss:{bg:'#F4F4F1',fg:'#101010',muted:'#565656',accent:'#E12B21',panel:'#FFFFFF',display:'Swiss'},
  cinema:{bg:'#030303',fg:'#F7F5EF',muted:'#9A918A',accent:'#B65A38',panel:'#0B0807',display:'Cinema'},
  instagram:{bg:'#FFFFFF',fg:'#111111',muted:'#737373',accent:'#0095F6',panel:'#FFFFFF',display:'Instagram'}
};

function pageBackground(t, page, size) {
  const w=size.width,h=size.height;
  const v=[{canvas:[{type:'rect',x:0,y:0,w,h,color:t.bg}]}];
  if(page===1){
    if(t===THEMES.case) v.push({canvas:[{type:'line',x1:42,y1:70,x2:w-42,y2:70,lineColor:'#333333',lineWidth:1},{type:'line',x1:42,y1:h-70,x2:w-42,y2:h-70,lineColor:'#333333',lineWidth:1}]});
    if(t===THEMES.zine) v.push({canvas:[{type:'rect',x:28,y:28,w:w-56,h:h-56,lineColor:'#070707',lineWidth:2},{type:'rect',x:w-118,y:52,w:72,h:88,color:t.accent}]});
    if(t===THEMES.fashion) v.push({canvas:[{type:'rect',x:w-74,y:0,w:74,h,color:'#1A1A1A'}]});
    if(t===THEMES.manual) v.push({canvas:[{type:'rect',x:34,y:34,w:w-68,h:h-68,lineColor:t.fg,lineWidth:1}]});
    if(t===THEMES.swiss) v.push({canvas:[{type:'rect',x:w-68,y:0,w:68,h,color:t.accent},{type:'rect',x:0,y:0,w:w-68,h:26,color:t.fg}]});
    if(t===THEMES.cinema) v.push({canvas:[{type:'ellipse',x:w-180,y:155,r1:115,r2:115,color:'#32130C'},{type:'ellipse',x:w-180,y:155,r1:76,r2:76,color:t.bg}]});
    if(t===THEMES.instagram) v.push({canvas:[{type:'line',x1:0,y1:44,x2:w,y2:44,lineColor:'#DBDBDB',lineWidth:1},{type:'ellipse',x:52,y:92,r1:24,r2:24,color:t.accent}]});
  } else {
    if(t===THEMES.zine) v.push({canvas:[{type:'rect',x:28,y:28,w:w-56,h:h-56,lineColor:'#070707',lineWidth:1.5}]});
    if(t===THEMES.manual) v.push({canvas:[{type:'rect',x:34,y:34,w:w-68,h:h-68,lineColor:t.fg,lineWidth:0.8}]});
    if(t===THEMES.swiss) v.push({canvas:[{type:'rect',x:0,y:0,w,h:18,color:t.accent}]});
    if(t===THEMES.instagram) v.push({canvas:[{type:'line',x1:0,y1:38,x2:w,y2:38,lineColor:'#DBDBDB',lineWidth:1}]});
  }
  return v;
}

function sectionHeading(sec,t){
  if(t===THEMES.instagram){
    return {stack:[
      {table:{widths:[42,'*'],body:[[
        {text:String(sec.num),color:'#FFFFFF',fillColor:t.accent,border:[false,false,false,false],alignment:'center',margin:[0,5,0,5],bold:true},
        {text:'@ai.reels.engine  ✓',color:t.fg,border:[false,false,false,false],margin:[6,5,0,5],bold:true,fontSize:9}
      ]]},layout:'noBorders',margin:[0,8,0,7]},
      {text:sec.title,style:'sectionTitle'}
    ]};
  }
  if(t===THEMES.swiss){
    return {columns:[
      {width:50,stack:[{text:String(sec.num).padStart(2,'0'),fontSize:18,bold:true,color:'#FFFFFF',fillColor:t.accent,margin:[8,7,0,7]}]},
      {width:'*',text:sec.title,style:'sectionTitle',margin:[10,0,0,0]}
    ],margin:[0,8,0,8]};
  }
  if(t===THEMES.zine){
    return {stack:[
      {table:{widths:[50,'*'],body:[[
        {text:String(sec.num).padStart(2,'0'),bold:true,fontSize:15,fillColor:t.accent,color:t.fg,margin:[8,6,0,6],border:[true,true,true,true]},
        {text:'STEP / CREATIVE PIPELINE',fontSize:7,bold:true,fillColor:t.panel,color:t.fg,margin:[8,9,0,6],border:[true,true,true,true]}
      ]]},layout:{hLineColor:()=>t.fg,vLineColor:()=>t.fg,hLineWidth:()=>1.2,vLineWidth:()=>1.2},margin:[0,9,0,7]},
      {text:sec.title,style:'sectionTitle'}
    ]};
  }
  if(t===THEMES.manual){
    return {stack:[
      {text:'PROCEDURE // '+String(sec.num).padStart(2,'0'),fontSize:7,bold:true,color:t.fg,margin:[0,8,0,4]},
      {canvas:[{type:'line',x1:0,y1:0,x2:480,y2:0,lineColor:t.fg,lineWidth:1}]},
      {text:sec.title,style:'sectionTitle',margin:[0,7,0,0]}
    ]};
  }
  if(t===THEMES.case){
    return {stack:[
      {text:'EVIDENCE / STEP '+String(sec.num).padStart(2,'0'),fontSize:7,color:t.muted,margin:[0,8,0,4]},
      {canvas:[{type:'line',x1:0,y1:0,x2:480,y2:0,lineColor:'#444444',lineWidth:0.8}]},
      {text:sec.title,style:'sectionTitle',margin:[0,7,0,0]}
    ]};
  }
  return {stack:[
    {text:String(sec.num).padStart(2,'0'),fontSize:7,bold:true,color:t.accent,margin:[0,8,0,3]},
    {canvas:[{type:'line',x1:0,y1:0,x2:480,y2:0,lineColor:t.accent,lineWidth:1}]},
    {text:sec.title,style:'sectionTitle',margin:[0,7,0,0]}
  ]};
}

function contentFor(themeName, preview=false){
  const t=THEMES[themeName]||THEMES.original;
  const c=[];
  if(themeName==='instagram') c.push({text:'Instagram',fontSize:16,italics:true,color:t.fg,margin:[0,0,0,26]});
  c.push({text:'АНДРЕЙ / ТВОРЧЕСКИЙ ПАЙПЛАЙН',style:'eyebrow'});
  c.push({text:data.title,style:'coverTitle'});
  c.push({text:data.subtitle,style:'subtitle'});
  if(['case','manual','swiss'].includes(themeName)){
    c.push({table:{widths:['*','*','*'],body:[[
      {stack:[{text:'16',fontSize:17,bold:true},{text:'STEPS',fontSize:6,color:t.muted}]},
      {stack:[{text:'AI',fontSize:17,bold:true},{text:'CO-PILOT',fontSize:6,color:t.muted}]},
      {stack:[{text:'1',fontSize:17,bold:true},{text:'PIPELINE',fontSize:6,color:t.muted}]}
    ]]},layout:{fillColor:()=>t.panel,hLineColor:()=>t.accent,vLineColor:()=>t.accent,hLineWidth:()=>0.7,vLineWidth:()=>0.7},margin:[0,7,0,12]});
  }
  for(const p of data.intro) c.push({text:p,style:'lead'});
  if(themeName==='instagram') c.push({text:'♡ 284K     ◯ 4.2K     ▱ Save',fontSize:8,bold:true,color:t.fg,margin:[0,5,0,0]});
  c.push({text:'',pageBreak:'after'});

  const secs=preview ? data.sections.slice(0,2) : data.sections;
  for(const sec of secs){
    c.push(sectionHeading(sec,t));
    for(const b of sec.blocks){
      if(b.type==='p') c.push({text:b.text,style:'body'});
      else for(const item of b.items) c.push({text:'•  '+item,style:'bullet'});
    }
    if(themeName==='instagram') c.push({text:'♡     ◯     ⌁     ▱',fontSize:10,color:t.fg,margin:[0,4,0,8]});
    if(themeName==='cinema') c.push({text:'CUT / STEP '+String(sec.num).padStart(2,'0'),fontSize:7,color:t.muted,margin:[0,2,0,8]});
  }
  if(preview){
    c.push({text:'FULL PDF AVAILABLE AFTER PURCHASE',fontSize:11,bold:true,color:t.accent,alignment:'center',margin:[0,18,0,4]});
    c.push({text:'This preview contains the cover and first two steps.',fontSize:8,color:t.muted,alignment:'center'});
  }
  return c;
}

function definition(themeName,preview){
  const t=THEMES[themeName]||THEMES.original;
  const isDark=['case','cinema'].includes(themeName);
  const coverSize=['case','zine','swiss'].includes(themeName)?40:(['fashion','cinema','editorial'].includes(themeName)?38:34);
  return {
    pageSize:'A4',
    pageMargins:[54,60,54,52],
    background:(page,size)=>pageBackground(t,page,size),
    header:(page)=> page===1?null:{text:themeName==='instagram'?'ai.reels.engine  ✓':'АНДРЕЙ / ТВОРЧЕСКИЙ ПАЙПЛАЙН',fontSize:6,color:t.muted,margin:[54,24,54,0]},
    footer:(page)=>({columns:[{text:'AI REELS ENGINE',fontSize:6,color:t.muted},{text:String(page),fontSize:6,color:t.muted,alignment:'right'}],margin:[54,0,54,20]}),
    defaultStyle:{font:'Roboto',fontSize:9.4,lineHeight:1.38,color:t.fg},
    styles:{
      eyebrow:{fontSize:6.5,bold:true,color:t.muted,characterSpacing:1.1,margin:[0,26,0,12]},
      coverTitle:{fontSize:coverSize,bold:!['editorial','fashion','cinema'].includes(themeName),color:t.fg,lineHeight:0.96,margin:[0,0,0,7]},
      subtitle:{fontSize:8.5,color:t.muted,margin:[0,0,0,16]},
      lead:{fontSize:['editorial','fashion','cinema'].includes(themeName)?10.5:9.6,lineHeight:1.43,color:t.fg,margin:[0,0,0,9]},
      sectionTitle:{fontSize:['editorial','fashion','cinema'].includes(themeName)?18:15.5,bold:true,color:t.fg,lineHeight:1.05,margin:[0,0,0,9]},
      body:{fontSize:9.2,lineHeight:1.45,color:t.fg,margin:[0,0,0,8]},
      bullet:{fontSize:9.1,lineHeight:1.4,color:t.fg,margin:[9,0,0,4]}
    },
    content:contentFor(themeName,preview),
    info:{title:'Творческий пайплайн - Андрей',author:'AI Reels Engine',subject:t.display+' edition'}
  };
}

function generatePdf(themeName='original', preview=false){
  if(!THEMES[themeName]) themeName='original';
  return new Promise((resolve,reject)=>{
    try{
      pdfMake.createPdf(definition(themeName,preview)).getBuffer((buf)=>resolve(Buffer.from(buf)));
    }catch(e){reject(e)}
  });
}

module.exports={generatePdf,THEMES};
