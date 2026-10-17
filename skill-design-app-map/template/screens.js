/* Example screens — replace with the real app. One file per area is fine (screens-home.js, screens-settings.js …);
   add each file as a <script src> in app-map.html before the engine script. */

S.app = { name: 'Notes', key: 'notes-map-v1' };              // key = localStorage namespace for picks/state
S.tabs = [['home','home-variant','Home',true], ['settings','cog-outline','Settings']];  // [id, mdi icon, label, center?]
S.tabColors = { launch:'#1d1442', home:'#06B6D4', settings:'#F59E0B' };
// Optional shared state for switches that change other screens (.sw[data-pin|data-mod]); S.refresh = screens to redraw
S.state0 = { pins:['recent'], order:['recent'], mod:{ sync:1 } };
S.refresh = ['home','settings'];

S.global.push('Language: English, left-to-right.', 'One emphasized action per screen.');

S.add({ id:'launch', title:'App opens', tab:'launch', decided:'Wordmark only, ~1 s, then Home.',
  html:()=>H.scr(`<div class="body center" data-go="home" style="cursor:pointer"><div class="t0">Notes</div></div>`) });

S.add({ id:'home', title:'Home', rank:1, tab:'home', parent:'launch', note:'Two genuinely different layouts to pick from.', variants:[
  { label:'List', note:'Newest first, one big “New note”.',
    html:()=>H.scr(`<div class="body"><div class="t0" style="margin:6px 0 16px">Notes</div>
      <button class="btn wide" data-go="edit">New note</button>
      ${PS.mod.sync?'<div class="p2" style="font-size:13px;margin:10px 0">Synced</div>':''}
      <div class="wcard" style="padding:2px 16px;margin-top:10px">${['Groceries','Ideas','Trip'].map(t=>`<div class="row" data-go="edit"><div class="grow"><div class="ttl">${t}</div></div><i class="mdi mdi-chevron-right chev"></i></div>`).join('')}</div>
    </div>`,{tab:'home'}) },
  { label:'Grid', note:'Cards in two columns, quick + in the corner.',
    html:()=>H.scr(`<div class="body"><div class="t0" style="margin:6px 0 16px">Notes</div>
      <div class="grid2">${['Groceries','Ideas','Trip','Books'].map(t=>`<div class="wcard" data-go="edit" style="height:110px;cursor:pointer"><div class="ttl">${t}</div></div>`).join('')}</div>
      <div style="flex:1"></div><button class="btn wide" data-go="edit">New note</button></div>`,{tab:'home'}) },
]});

S.add({ id:'edit', title:'Edit note', tab:'home', parent:'home', link:'next', via:'tap a note',   // link:'next' = drawn to the right (a sequence)
  html:()=>H.scr(`<div class="body">${H.back('Notes')}<input class="inp focus" value="Groceries" style="font:700 22px var(--body)">
    <div class="chips" data-group>${['Home','Work','Later'].map((c,i)=>`<span class="chip ${i?'':'on'}" data-sel>${c}</span>`).join('')}</div>
    <div style="flex:1"></div><button class="btn wide" data-go="back">Save</button></div>`) });

S.add({ id:'settings', title:'Settings', rank:2, tab:'settings', parent:'launch',
  html:()=>H.scr(`<div class="body"><div class="t0" style="margin:6px 0 16px">Settings</div>
    <div class="wcard" style="padding:2px 16px"><div class="row" style="cursor:default"><div class="grow"><div class="ttl">Sync</div></div><div class="sw ${PS.mod.sync?'on':''}" data-mod="sync"></div></div></div>
  </div>`,{tab:'settings'}) });
