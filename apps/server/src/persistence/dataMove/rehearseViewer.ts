// @effect-diagnostics nodeBuiltinImport:off -- Host-side image-only boundary for the isolated browser.
import * as NodeHttp from "node:http";

const viewerHtml = `<!doctype html><meta charset="utf-8"><title>styal rehearsal</title>
<style>body{margin:0;background:#ddd;font:14px sans-serif}header{padding:8px}img{display:block;width:1280px;height:800px}button{margin-right:12px}</style>
<header><button id="back">Back</button><button id="reload">Reload app</button><button id="refresh">Refresh view</button>Isolated rehearsal browser. Repositories and outside services are unavailable.</header><img id="screen" draggable="false" tabindex="0" alt="Rehearsal application">
<script>
const screen=document.querySelector('#screen');
let busy=false;
async function frame(){if(busy)return;busy=true;try{const r=await fetch('/frame');if(r.ok){const blob=await r.blob();const old=screen.src;screen.src=URL.createObjectURL(blob);if(old)URL.revokeObjectURL(old)}}finally{busy=false}}
async function input(value){await fetch('/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});await frame()}
screen.addEventListener('click',e=>{screen.focus();const r=screen.getBoundingClientRect();input({type:'click',x:e.clientX-r.left,y:e.clientY-r.top})});
screen.addEventListener('wheel',e=>{e.preventDefault();input({type:'wheel',x:e.deltaX,y:e.deltaY})},{passive:false});
screen.addEventListener('keydown',e=>{e.preventDefault();input({type:'key',key:e.key})});
screen.addEventListener('paste',e=>{e.preventDefault();input({type:'text',text:e.clipboardData.getData('text/plain')})});
document.querySelector('#back').onclick=()=>input({type:'back'});
document.querySelector('#reload').onclick=()=>input({type:'reload'});
document.querySelector('#refresh').onclick=frame;frame();
</script>`;

export function createRehearsalViewer(
  exchange: (path: string, body?: string) => Promise<{ status: number; bytes: Buffer }>,
) {
  return NodeHttp.createServer(async (request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    );
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (request.method === "GET" && request.url === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(viewerHtml);
      } else if (request.method === "GET" && request.url === "/frame") {
        const { status, bytes } = await exchange("/frame");
        if (status !== 200 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
          throw new Error("png-required");
        response.setHeader("Content-Type", "image/png");
        response.end(bytes);
      } else if (request.method === "POST" && request.url === "/input") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 4096) throw new Error("input-too-large");
        }
        await exchange("/input", body);
        response.end();
      } else {
        response.statusCode = 404;
        response.end();
      }
    } catch {
      response.statusCode = 503;
      response.end("Rehearsal browser unavailable");
    }
  });
}
