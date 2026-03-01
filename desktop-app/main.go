package main

import (
	"fmt"

	webview "github.com/webview/webview_go"
)

// defaultW / defaultH — initial window content size on first launch.
const defaultW, defaultH = 1280, 800

// overlayJS is injected on every page load via w.Init().
//
// Safety guards:
//   - Skips non-http(s) pages (e.g. the setup page loaded via SetHtml which
//     appears as about:srcdoc / about:blank in some runtimes).
//   - Idempotent: the __ov_injected flag prevents double-injection on
//     same-origin navigations that don't fully reload the engine.
//
// Exposes:
//   - window.__obliview_is_native_app = true   (React app uses this to hide
//     the "Download App" header link)
//   - Listens for 'obliview:notify' CustomEvents dispatched by the React app
//     and plays a distinct audio beep per notification type:
//       probe_down  · probe_up  · agent_alert  · agent_fixed
//   - Bottom-right ⚙ gear button that opens a URL-change dialog.
//     On save → calls window.__go_saveURL(url) then navigates.
const overlayJS = `(function(){
  if(!/^https?:/.test(location.protocol))return;
  if(window.__ov_injected)return;
  window.__ov_injected=true;
  window.__obliview_is_native_app=true;

  /* ── Sounds ──────────────────────────────────────────────── */
  function tone(f,t,d,v){
    try{
      var c=new(window.AudioContext||window.webkitAudioContext)();
      var o=c.createOscillator(),g=c.createGain();
      o.connect(g);g.connect(c.destination);
      o.type=t||'sine';o.frequency.value=f;
      g.gain.setValueAtTime(v||.12,c.currentTime);
      g.gain.exponentialRampToValueAtTime(.001,c.currentTime+d);
      o.start(c.currentTime);o.stop(c.currentTime+d);
    }catch(e){}
  }
  var S={
    probe_down:function(){
      tone(440,'square',.12,.13);
      setTimeout(function(){tone(290,'square',.24,.13)},115);
    },
    probe_up:function(){
      tone(440,'sine',.12,.09);
      setTimeout(function(){tone(660,'sine',.2,.09)},125);
    },
    agent_alert:function(){
      tone(880,'triangle',.09,.11);
      setTimeout(function(){tone(880,'triangle',.09,.11)},145);
      setTimeout(function(){tone(1100,'triangle',.15,.11)},290);
    },
    agent_fixed:function(){
      tone(523,'sine',.1,.08);
      setTimeout(function(){tone(659,'sine',.13,.08)},115);
      setTimeout(function(){tone(784,'sine',.2,.08)},230);
    }
  };
  window.addEventListener('obliview:notify',function(e){
    var f=S[e.detail&&e.detail.type];
    if(f)f();
  });

  /* ── URL-change dialog ───────────────────────────────────── */
  function openDialog(){
    var ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(8px)';
    var bx=document.createElement('div');
    bx.style.cssText='background:#1e1e2e;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:28px 32px;width:400px;color:#e0e0e0;font-family:system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.55)';
    bx.innerHTML=
      '<h3 style="margin:0 0 8px;font-size:16px;font-weight:600;color:#fff">Change Obliview URL</h3>'+
      '<p style="margin:0 0 18px;font-size:13px;color:#888;line-height:1.55">Enter the URL of your Obliview server. The app will reload.</p>'+
      '<input id="__ov_i" type="url" placeholder="https://obliview.example.com"'+
        ' style="width:100%;box-sizing:border-box;padding:9px 12px;background:#252538;border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#e0e0e0;font-size:14px;outline:none;margin-bottom:16px">'+
      '<div style="display:flex;gap:8px;justify-content:flex-end">'+
        '<button id="__ov_c" style="padding:7px 16px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,.15);color:#aaa;cursor:pointer;font-size:13px">Cancel</button>'+
        '<button id="__ov_s" style="padding:7px 16px;border-radius:6px;background:#6366f1;border:none;color:#fff;cursor:pointer;font-size:13px;font-weight:500">Save &amp; Reload</button>'+
      '</div>';
    ov.appendChild(bx);
    document.body.appendChild(ov);
    var inp=document.getElementById('__ov_i');
    inp.focus();
    function close(){if(ov.parentNode)document.body.removeChild(ov);}
    document.getElementById('__ov_c').onclick=close;
    ov.onclick=function(e){if(e.target===ov)close();};
    inp.addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('__ov_s').click();});
    document.getElementById('__ov_s').onclick=function(){
      var u=inp.value.trim();
      if(!u)return;
      if(!/^https?:\/\//i.test(u))u='https://'+u;
      window.__go_saveURL(u).then(function(){window.location.replace(u);});
    };
  }

  /* ── Gear button ─────────────────────────────────────────── */
  function injectGear(){
    if(document.getElementById('__ov_g'))return;
    var b=document.createElement('button');
    b.id='__ov_g';
    b.title='Change Obliview URL';
    b.textContent='\u2699';
    b.style.cssText=[
      'position:fixed','bottom:14px','right:14px',
      'z-index:2147483646','width:34px','height:34px',
      'border-radius:50%','background:rgba(12,12,22,.78)',
      'color:#777','font-size:17px',
      'border:1px solid rgba(255,255,255,.1)',
      'cursor:pointer','display:flex','align-items:center',
      'justify-content:center','backdrop-filter:blur(4px)',
      'opacity:.38','transition:opacity .2s,color .2s',
      'line-height:1','padding:0'
    ].join(';');
    b.onmouseenter=function(){b.style.opacity='.95';b.style.color='#fff';};
    b.onmouseleave=function(){b.style.opacity='.38';b.style.color='#777';};
    b.onclick=openDialog;
    document.body.appendChild(b);
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',injectGear);
  }else{
    injectGear();
  }

  /* ── Window-size persistence ──────────────────────────────────────── */
  // Debounced resize listener: after the user stops dragging the window
  // edge, call the Go binding so the new size is remembered across restarts.
  // Uses window.innerWidth/innerHeight which matches the content-area size
  // that webview.SetSize() expects (both use logical/CSS pixels).
  var __ov_rs_t=null;
  window.addEventListener('resize',function(){
    clearTimeout(__ov_rs_t);
    __ov_rs_t=setTimeout(function(){
      if(typeof window.__go_saveSize==='function'){
        window.__go_saveSize(window.innerWidth,window.innerHeight).catch(function(){});
      }
    },600);
  });
})();`

// setupHTML is shown on first launch when no URL has been saved yet.
// It is loaded via w.SetHtml(), so window.location.protocol will NOT be http/https.
// The overlayJS guard (!/^https?:/.test(location.protocol)) skips injection here.
const setupHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Obliview</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f17;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1a1a2e;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:40px 44px;width:420px;box-shadow:0 24px 80px rgba(0,0,0,.6)}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:28px}
.ico{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:22px}
.name{font-size:22px;font-weight:700;color:#fff;letter-spacing:-.3px}
h2{font-size:17px;font-weight:600;color:#fff;margin-bottom:8px}
p{font-size:13px;color:#888;margin-bottom:24px;line-height:1.6}
label{display:block;font-size:11px;font-weight:600;color:#999;margin-bottom:7px;letter-spacing:.6px;text-transform:uppercase}
input{width:100%;padding:10px 14px;background:#252538;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e0e0e0;font-size:14px;outline:none;transition:border-color .15s;margin-bottom:18px}
input:focus{border-color:#6366f1}
input::placeholder{color:#555}
button{width:100%;padding:11px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s;letter-spacing:.1px}
button:hover{opacity:.88}
.err{font-size:12px;color:#f87171;margin-top:12px;min-height:16px;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="ico">&#x1F441;</div>
    <div class="name">Obliview</div>
  </div>
  <h2>Welcome</h2>
  <p>Enter the URL of your Obliview instance to connect. You can change it at any time using the &#x2699; icon.</p>
  <label>Server URL</label>
  <input id="u" type="url" placeholder="https://obliview.example.com" autocomplete="off">
  <button onclick="go()">Connect &#x2192;</button>
  <div class="err" id="e"></div>
</div>
<script>
document.getElementById('u').focus();
document.getElementById('u').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
function go(){
  var u=document.getElementById('u').value.trim();
  if(!u){err('Please enter a URL');return;}
  if(!/^https?:\/\//i.test(u))u='https://'+u;
  try{new URL(u);}catch(e){err('Please enter a valid URL');return;}
  window.__go_saveURL(u).then(function(){window.location.replace(u);});
}
function err(m){
  var e=document.getElementById('e');
  e.textContent=m;
  setTimeout(function(){e.textContent='';},3000);
}
</script>
</body>
</html>`

func main() {
	cfg, _ := loadConfig()

	// Restore saved content-area dimensions, falling back to defaults on first run.
	winW, winH := defaultW, defaultH
	if cfg.Width >= 400 && cfg.Height >= 300 {
		winW, winH = cfg.Width, cfg.Height
	} else {
		// Initialise so the first save (URL change or close) records a valid size.
		cfg.Width, cfg.Height = defaultW, defaultH
	}

	w := webview.New(false)
	defer w.Destroy()

	w.SetTitle("Obliview")
	w.SetSize(winW, winH, webview.HintNone)

	// Apply the app icon to the window (title bar on Windows, Dock on macOS).
	// On macOS this also installs the standard Edit + App menu so that keyboard
	// shortcuts such as Cmd+C, Cmd+Q, Cmd+V … work inside WKWebView.
	applyWindowIcon(w.Window())

	// __go_saveURL is callable from JS on both the setup page and the gear dialog.
	// It persists the URL to disk; the JS side then does window.location.replace(url).
	// We update cfg in-place so that Width/Height are not overwritten.
	if err := w.Bind("__go_saveURL", func(url string) {
		cfg.URL = url
		if err := saveConfig(cfg); err != nil {
			fmt.Println("[obliview] error saving config:", err)
		}
	}); err != nil {
		fmt.Println("[obliview] bind error:", err)
	}

	// __go_saveSize is called from overlayJS (debounced resize listener).
	// It keeps cfg up-to-date in memory; the final saveConfig below persists it.
	if err := w.Bind("__go_saveSize", func(width, height float64) {
		if width >= 400 && height >= 300 {
			cfg.Width = int(width)
			cfg.Height = int(height)
		}
	}); err != nil {
		fmt.Println("[obliview] bind error:", err)
	}

	// Inject the overlay script on every page load.
	w.Init(overlayJS)

	if cfg.URL == "" {
		// First run — show the local setup page.
		w.SetHtml(setupHTML)
	} else {
		// Navigate directly to the configured Obliview instance.
		w.Navigate(cfg.URL)
	}

	w.Run()

	// Window closed — persist the final config (URL + last-known window size).
	if err := saveConfig(cfg); err != nil {
		fmt.Println("[obliview] error saving config on exit:", err)
	}
}
