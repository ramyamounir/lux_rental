(function(){
"use strict";

// ---------- state ----------
var state = {
  view: 'country',      // 'country' | 'city'
  layer: 'combined',    // 'combined' | 'afford' | 'connect' | 'amenity' | 'safety'
  selected: null,       // {type, name}
  weights: {afford:35, connect:30, amenity:20, safety:15}
};
function slug(name){ return name.replace(/\s+/g,'_'); }

// ---------- color scale ----------
var STOPS = [
  [0.0,  [58,66,84]],
  [0.45, [110,97,66]],
  [0.75, [217,164,65]],
  [1.0,  [242,197,114]]
];
function scoreToColor(score){
  var t = Math.max(0,Math.min(100, score||0))/100;
  for(var i=0;i<STOPS.length-1;i++){
    var p0=STOPS[i][0], c0=STOPS[i][1], p1=STOPS[i+1][0], c1=STOPS[i+1][1];
    if(t>=p0 && t<=p1){
      var f = p1>p0 ? (t-p0)/(p1-p0) : 0;
      var r = Math.round(c0[0]+f*(c1[0]-c0[0]));
      var g = Math.round(c0[1]+f*(c1[1]-c0[1]));
      var b = Math.round(c0[2]+f*(c1[2]-c0[2]));
      return 'rgb('+r+','+g+','+b+')';
    }
  }
  var last = STOPS[STOPS.length-1][1];
  return 'rgb('+last.join(',')+')';
}

// ---------- scoring ----------
// Inverted model: every area is "presumed safe" (baseline 90) unless a documented
// crime concentration was found; those carry a lower score. Always non-null now.
function getSafetyScore(type,name,obj){
  return (obj && obj.score_safety!=null) ? obj.score_safety : 90;
}
function combinedScore(obj,type,name){
  var w = state.weights;
  var total = w.afford + w.connect + w.amenity + w.safety;
  if(total<=0) return 50;
  return (obj.score_afford*w.afford + obj.score_connect*w.connect +
          obj.score_amenity*w.amenity + getSafetyScore(type,name,obj)*w.safety) / total;
}
function scoreFor(obj,type,name,layer){
  if(layer==='afford') return obj.score_afford;
  if(layer==='connect') return obj.score_connect;
  if(layer==='amenity') return obj.score_amenity;
  if(layer==='safety') return getSafetyScore(type,name,obj);
  return combinedScore(obj,type,name);
}

// ---------- data accessors ----------
function currentDict(){ return state.view==='country' ? COMMUNES : QUARTIERS; }
function currentType(){ return state.view==='country' ? 'commune' : 'quartier'; }

// ---------- map setup ----------
// No external tile server: the sandboxed artifact environment blocks it, which
// left the city view (all points, no polygons) with nothing to render against.
// Everything below is drawn from the embedded boundary data instead.
var map = L.map('map', {zoomControl:true, attributionControl:true, minZoom:8, maxZoom:16});
L.control.attribution({prefix:false}).addAttribution('Boundaries: government open data, simplified').addTo(map);

// Optional street basemap (off by default — the app's default look is the clean
// dark canvas). CARTO Voyager: light, labeled roads. Lives in the default tilePane
// (z-index 200), so it sits beneath every score polygon and transit line. When on,
// the choropleth fill is dimmed (see setBasemap) so streets read through.
var streetTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  subdomains:'abcd', maxZoom:19, attribution:'© OpenStreetMap contributors · © CARTO'
});
var CHORO_OPACITY = 0.85;
var BASEMAP_ON = false;
function setBasemap(on){
  BASEMAP_ON = !!on;
  if(on){ streetTiles.addTo(map); CHORO_OPACITY = 0.42; }
  else { map.removeLayer(streetTiles); CHORO_OPACITY = 0.85; }
  communeLayer.setStyle(communeStyle);
  quartierLayer.setStyle(quartierStyle);
  // The context/city-boundary layers have opaque fills that would otherwise
  // sit on top of the street tiles (tiles live in the low tilePane), hiding
  // them and leaving only white slivers in the gaps between polygons. Drop
  // their fills to transparent when the basemap is on so streets read through.
  contextLayer.setStyle(contextStyle);
  cityBoundaryLayer.setStyle(cityBoundaryStyle);
}

var communeLayer = L.geoJSON(COMMUNES_GEOJSON, {
  style: communeStyle,
  onEachFeature: function(feature, layer){
    var name = feature.properties.name;
    layer.bindTooltip(name, {sticky:true, className:'lx-tip'});
    layer.on('click', function(e){ L.DomEvent.stopPropagation(e); selectArea('commune', name); });
    layer.on('mouseover', function(e){ e.target.setStyle({weight:2, color:'#f2c572'}); });
    layer.on('mouseout', function(e){ communeLayer.resetStyle(e.target); });
  }
});

// Faint national outline shown behind the city view so the quartier dots
// have geographic context (all communes, low-contrast, non-interactive).
function contextStyle(){
  return {fillColor:'#1a2029', fillOpacity: BASEMAP_ON ? 0 : 1, weight:0.6, color:'#262e38'};
}
var contextLayer = L.geoJSON(COMMUNES_GEOJSON, {
  style: contextStyle,
  interactive:false
});

// The city commune's own outline, drawn brighter on top of the context layer
// while in city view.
var cityFeature = null;
for(var i=0;i<COMMUNES_GEOJSON.features.length;i++){
  if(COMMUNES_GEOJSON.features[i].properties.name==='Luxembourg'){ cityFeature = COMMUNES_GEOJSON.features[i]; break; }
}
function cityBoundaryStyle(){
  return {fillColor:'#20293a', fillOpacity: BASEMAP_ON ? 0 : 1, weight:1.5, color:'#46536a'};
}
var cityBoundaryLayer = L.geoJSON(cityFeature, {
  style: cityBoundaryStyle,
  interactive:false
});

// Quartier polygons: VDL's official boundaries exist but weren't fetchable from this
// tool's sandbox (the API returns valid GeoJSON, but as a MIME type this environment's
// fetcher won't decode as text). These are a Voronoi tessellation seeded at each
// quartier's real centroid and clipped to the real city outline instead \u2014 a labelled
// approximation, not the official polygons, but it tiles the whole city with no gaps.
var quartierLayer = L.geoJSON(QUARTIERS_GEOJSON, {
  style: quartierStyle,
  onEachFeature: function(feature, layer){
    var name = feature.properties.name;
    layer.bindTooltip(name, {sticky:true, className:'lx-tip'});
    layer.on('click', function(e){ L.DomEvent.stopPropagation(e); selectArea('quartier', name); });
    layer.on('mouseover', function(e){ e.target.setStyle({weight:2, color:'#f2c572'}); });
    layer.on('mouseout', function(e){ quartierLayer.resetStyle(e.target); });
  }
});
// state.layer===null means no layer is selected: hide the score fills entirely
// (the user clicked the active tab off) so the base map / boundaries show alone.
function choroFillOpacity(){ return state.layer===null ? 0 : CHORO_OPACITY; }

function quartierStyle(feature){
  var name = feature.properties.name;
  var obj = QUARTIERS[name];
  var s = obj ? scoreFor(obj,'quartier',name,state.layer) : 50;
  return {fillColor: scoreToColor(s), weight:1, color:'#12161d', fillOpacity:choroFillOpacity()};
}

function communeStyle(feature){
  var name = feature.properties.name;
  var obj = COMMUNES[name];
  var s = obj ? scoreFor(obj,'commune',name,state.layer) : 50;
  return {fillColor: scoreToColor(s), weight:1, color:'#12161d', fillOpacity:choroFillOpacity()};
}

function fitCountry(){
  try{ map.fitBounds(communeLayer.getBounds(), {padding:[8,8]}); }
  catch(e){ map.setView([49.73,6.12],9); }
}
function fitCity(){
  try{ map.fitBounds(cityBoundaryLayer.getBounds(), {padding:[18,18]}); }
  catch(e){ map.setView([49.612,6.128], 13); }
}

// ---------- transit overlays ----------
// Real route geometry from Luxembourg's national GTFS feed (data.public.lu):
// every route shape, Douglas-Peucker-simplified and de-duplicated into a network
// of polylines per mode (see data/transit_network.json). Rail additionally keeps
// station markers sized by real 2022 CFL ridership. Each mode is an independent,
// separately-toggleable layer. Dedicated panes fix draw order so dense bus lines
// sit under tram, and tram under rail, whatever order the toggles are switched in.
var TRANSIT_STYLE = {
  bus:  {color:'#6bbfa0', weight:1,   opacity:0.36, z:411},
  tram: {color:'#d9789f', weight:3,   opacity:0.9,  z:412},
  rail: {color:'#6fa8c9', weight:2.4, opacity:0.85, z:413}
};
function buildNetworkGroup(mode){
  var st = TRANSIT_STYLE[mode], pane = mode+'Pane';
  map.createPane(pane);
  map.getPane(pane).style.zIndex = st.z;
  var g = L.layerGroup();
  (TRANSIT_NETWORK[mode] || []).forEach(function(path){
    L.polyline(path, {pane:pane, color:st.color, weight:st.weight, opacity:st.opacity,
      lineCap:'round', lineJoin:'round', interactive:false}).addTo(g);
  });
  return g;
}
var networkGroups = {
  bus:  buildNetworkGroup('bus'),
  tram: buildNetworkGroup('tram'),
  rail: buildNetworkGroup('rail')
};
(function buildRailStations(){
  // Real CFL station points from the national GTFS stops (see data/rail_stations.json):
  // each marker sits on the actual station location so it lands on the drawn rail line,
  // and is sized log-scale by scheduled trains/day at that station (representative
  // weekday, same feed as the geometry). A few cross-border/branch halts show no service
  // on the sample summer weekday; they're kept at minimum size and labelled honestly.
  var pane = 'railPane';
  var maxDep = 0;
  (RAIL_STATIONS || []).forEach(function(s){ if(s.dep_day>maxDep) maxDep = s.dep_day; });
  (RAIL_STATIONS || []).forEach(function(s){
    var r = s.dep_day>0
      ? 3 + 7*(Math.log10(s.dep_day+1)/Math.log10(maxDep+1))
      : 2.5;
    var m = L.circleMarker([s.lat, s.lon], {
      pane:pane, radius:r, weight:1.2, color:'#12161d', fillColor:'#6fa8c9',
      fillOpacity: s.dep_day>0 ? 0.95 : 0.55
    });
    var label = s.dep_day>0
      ? s.name+' \u2014 '+s.dep_day.toLocaleString('en-US')+' trains/day'
      : s.name+' \u2014 no scheduled trains on the sample summer weekday';
    m.bindTooltip(label, {sticky:true, className:'lx-tip'});
    m.on('click', function(e){ L.DomEvent.stopPropagation(e); });
    m.addTo(networkGroups.rail);
  });
})();

['bus','tram','rail'].forEach(function(mode){
  var el = document.getElementById(mode+'Toggle');
  if(!el) return;
  el.addEventListener('change', function(){
    if(el.checked) networkGroups[mode].addTo(map);
    else map.removeLayer(networkGroups[mode]);
  });
});

// ---------- amenity point-of-interest overlays ----------
// Real POIs from OpenStreetMap (via Overpass), one toggleable canvas layer per
// category. Rendered on a shared canvas renderer so thousands of dots stay fast.
var AMEN_CATS = [
  {key:'grocery',  color:'#e8b04a', label:'Groceries & food'},
  {key:'dining',   color:'#e2685a', label:'Restaurants / cafés / bars'},
  {key:'retail',   color:'#c98bd0', label:'Retail shops'},
  {key:'health',   color:'#5fb6d4', label:'Healthcare'},
  {key:'pharmacy', color:'#5fd0a0', label:'Pharmacies'},
  {key:'school',   color:'#d79a63', label:'Schools / childcare'},
  {key:'bank',     color:'#9aa0dc', label:'Banks / ATMs'},
  {key:'fuel',     color:'#d6d264', label:'Gas stations'},
  {key:'leisure',  color:'#78c98a', label:'Parks / sports'}
];
map.createPane('amenityPane');
map.getPane('amenityPane').style.zIndex = 420;
// the canvas renderer paints one element over the whole map; without this it would
// swallow every click before it reaches the commune polygons below (the dots
// themselves are non-interactive, so nothing is lost by making the pane click-through)
map.getPane('amenityPane').style.pointerEvents = 'none';
var amenityRenderer = L.canvas({pane:'amenityPane', padding:0.5});
var amenityGroups = {};
AMEN_CATS.forEach(function(c){
  var g = L.layerGroup();
  (AMENITIES_POI[c.key] || []).forEach(function(pt){
    L.circleMarker([pt[0], pt[1]], {
      renderer:amenityRenderer, radius:2.6, weight:0,
      fillColor:c.color, fillOpacity:0.78, interactive:false
    }).addTo(g);
  });
  amenityGroups[c.key] = g;
  var el = document.getElementById('am_'+c.key);
  if(!el) return;
  el.addEventListener('change', function(){
    if(el.checked) amenityGroups[c.key].addTo(map);
    else map.removeLayer(amenityGroups[c.key]);
  });
});

var streetToggle = document.getElementById('streetToggle');
if(streetToggle) streetToggle.addEventListener('change', function(){ setBasemap(this.checked); });

communeLayer.addTo(map);
fitCountry();
setTimeout(function(){ map.invalidateSize(); fitCountry(); }, 60);
window.addEventListener('resize', function(){ map.invalidateSize(); });

// ---------- view / layer toggles ----------
var btnCountry = document.getElementById('btnCountry');
var btnCity = document.getElementById('btnCity');
var viewTag = document.getElementById('viewTag');
var topLabel = document.getElementById('topLabel');
var weightsBlock = document.getElementById('weightsBlock');

btnCountry.addEventListener('click', function(){
  if(state.view==='country') return;
  state.view='country'; state.selected=null;
  btnCountry.classList.add('active'); btnCity.classList.remove('active');
  viewTag.textContent='Country';
  map.removeLayer(quartierLayer);
  map.removeLayer(contextLayer);
  map.removeLayer(cityBoundaryLayer);
  communeLayer.addTo(map);
  map.invalidateSize();
  fitCountry();
  renderAll();
});
btnCity.addEventListener('click', function(){
  if(state.view==='city') return;
  state.view='city'; state.selected=null;
  btnCity.classList.add('active'); btnCountry.classList.remove('active');
  viewTag.textContent='Luxembourg City · 24 quartiers';
  map.removeLayer(communeLayer);
  contextLayer.addTo(map);
  cityBoundaryLayer.addTo(map);
  quartierLayer.addTo(map);
  map.invalidateSize();
  fitCity();
  renderAll();
});

var layerTabs = document.getElementById('layerTabs');
layerTabs.querySelectorAll('button').forEach(function(btn){
  btn.addEventListener('click', function(){
    var val = btn.getAttribute('data-layer');
    // Clicking the already-active layer toggles it off: no layer selected, so
    // the score fills disappear and the base map shows through cleanly.
    if(state.layer===val){
      btn.classList.remove('active');
      state.layer = null;
    } else {
      layerTabs.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      state.layer = val;
    }
    weightsBlock.style.display = state.layer==='combined' ? 'block' : 'none';
    renderAll();
  });
});

['Afford','Connect','Amenity','Safety'].forEach(function(key){
  var input = document.getElementById('w'+key);
  var out = document.getElementById('w'+key+'V');
  input.addEventListener('input', function(){
    out.textContent = input.value;
    state.weights[key.toLowerCase()] = parseInt(input.value,10);
    if(state.layer==='combined') renderAll();
  });
});

// ---------- rendering ----------
function renderAll(){
  communeLayer.setStyle(communeStyle);
  quartierLayer.setStyle(quartierStyle);
  renderTopList();
  if(state.selected) renderDetail();
}

var LAYER_LABELS = {
  combined:'Top picks — combined score',
  afford:'Cheapest areas',
  connect:'Best connected',
  amenity:'Most amenities (real OSM POIs)',
  safety:'Safest (fewest documented issues)'
};

function renderTopList(){
  topLabel.textContent = LAYER_LABELS[state.layer] || 'Top picks';
  var dict = currentDict(); var type = currentType();
  var arr = [];
  for(var name in dict){ arr.push({name:name, score: scoreFor(dict[name], type, name, state.layer)}); }
  arr.sort(function(a,b){ return b.score-a.score; });
  var top = arr.slice(0,8);
  var html = '';
  top.forEach(function(item, i){
    html += '<div class="top-item" data-name="'+item.name.replace(/"/g,'&quot;')+'">' +
            '<span class="rank">'+(i+1)+'</span>' +
            '<span class="name">'+item.name+'</span>' +
            '<span class="score">'+Math.round(item.score)+'</span></div>';
  });
  var listEl = document.getElementById('toplist');
  listEl.innerHTML = html;
  listEl.querySelectorAll('.top-item').forEach(function(el){
    el.addEventListener('click', function(){
      var nm = el.getAttribute('data-name');
      selectArea(type, nm);
      flyTo(type, nm);
    });
  });
}

function flyTo(type, name){
  if(type==='commune'){
    var obj = COMMUNES[name];
    if(obj) map.flyTo([obj.centroid[0], obj.centroid[1]], 11.5, {duration:0.6});
  } else {
    var q = QUARTIERS[name];
    if(q) map.flyTo([q.lat,q.lon], 14.5, {duration:0.6});
  }
}

function selectArea(type, name){
  state.selected = {type:type, name:name};
  renderDetail();
}
function clearSelection(){
  state.selected = null;
  renderDetail();
}
map.on('click', clearSelection);

function fmtPrice(p){ return p ? p.toLocaleString('en-US') + ' \u20ac/m\u00b2' : '\u2014'; }

function renderDetail(){
  var sel = state.selected;
  var det = document.getElementById('detail');
  if(!sel){ det.innerHTML = '<div class="placeholder">Tap a commune on the map — or an item below — to see its numbers. Tap empty map space or the \u2715 to clear a selection.</div>'; return; }
  var type = sel.type, name = sel.name;
  var obj = type==='commune' ? COMMUNES[name] : QUARTIERS[name];
  if(!obj){ det.innerHTML=''; return; }

  var subLine, statsHtml;
  var amenityRow = '';
  if(obj.amenity_counts){
    var ac = obj.amenity_counts;
    amenityRow =
      row('Amenities (OSM)', obj.amenity_total.toLocaleString('en-US')+' places nearby') +
      row('Groceries \u00b7 dining', ac.grocery+' \u00b7 '+ac.dining) +
      row('Retail \u00b7 health \u00b7 pharm.', ac.retail+' \u00b7 '+ac.health+' \u00b7 '+ac.pharmacy) +
      row('Schools \u00b7 banks \u00b7 fuel', ac.school+' \u00b7 '+ac.bank+' \u00b7 '+ac.fuel) +
      row('Parks / sports', ac.leisure);
  }
  var transitRow = '';
  if(obj.transit_dep_day!=null){
    var modeBits = 'bus '+obj.bus_dep_day.toLocaleString('en-US')
      + (obj.tram_dep_day ? ' \u00b7 tram '+obj.tram_dep_day.toLocaleString('en-US') : '')
      + (obj.gtfs_rail_dep_day ? ' \u00b7 rail '+obj.gtfs_rail_dep_day.toLocaleString('en-US') : '');
    transitRow =
      row('Transit service', obj.transit_dep_day.toLocaleString('en-US')+' departures/day \u00b7 '+obj.transit_served_stops+' stops') +
      row('By mode (dep/day)', modeBits);
  }
  if(type==='commune'){
    subLine = obj.canton + ' canton \u00b7 ' + obj.dist_to_capital_km + ' km from Luxembourg City centre';
    statsHtml =
      row('Population', obj.population.toLocaleString('en-US')) +
      row('Density', obj.density.toLocaleString('en-US')+' /km\u00b2') +
      row('Price', fmtPrice(obj.price_m2)) +
      row('Price source', obj.price_source + (obj.price_estimated?' (canton avg. fallback)':'')) +
      amenityRow +
      transitRow +
      row('Rail station', obj.has_rail_station ? 'yes' : 'no') +
      (obj.has_rail_station ? row('Rail riders (2022)', obj.rail_passengers_2022.toLocaleString('en-US')+'/yr') : '');
  } else {
    subLine = (obj.tram ? 'Tram-served \u00b7 ' : '') + obj.dist_to_center_km + ' km from Ville Haute';
    statsHtml =
      row('Population', obj.population.toLocaleString('en-US')) +
      row('Density', obj.density.toLocaleString('en-US')+' /km\u00b2') +
      row('Price', fmtPrice(obj.price_m2)) +
      row('Price note', obj.price_note) +
      amenityRow +
      transitRow +
      (obj.rail_passengers_2022 ? row('Rail riders (2022)', obj.rail_passengers_2022.toLocaleString('en-US')+'/yr') : '');
  }

  var combined = combinedScore(obj, type, name);
  var effSafety = getSafetyScore(type, name, obj);
  var bars =
    scorebar('Afford.', obj.score_afford) +
    scorebar('Connect.', obj.score_connect) +
    scorebar('Amenities', obj.score_amenity) +
    scorebar('Safety', effSafety) +
    scorebar('Combined', combined);

  var documented = obj.safety_basis === 'documented';
  var safetyTag = documented
    ? '<span style="color:var(--red-flag);font-weight:600;">Documented issue</span>'
    : '<span style="color:var(--gold-bright);font-weight:600;">No documented issues</span>';
  var safetyNoteHtml = '<div class="sub" style="margin:6px 0 4px 0; line-height:1.5;">' +
    '<b style="color:'+(documented?'var(--red-flag)':'var(--gold-bright)')+';font-family:\'IBM Plex Mono\';">'+
      Math.round(effSafety)+'/100</b> \u00b7 ' + safetyTag + ' \u2014 ' +
    (obj.safety_source || '') + '</div>';

  det.innerHTML =
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">' +
      '<h2>'+name+'</h2>' +
      '<button id="clearSelBtn" title="Clear selection" aria-label="Clear selection" ' +
        'style="background:none;border:1px solid var(--hairline);color:var(--text-dim);' +
        'width:22px;height:22px;border-radius:6px;font-size:14px;line-height:1;cursor:pointer;flex-shrink:0;">\u2715</button>' +
    '</div>' +
    '<div class="sub">'+subLine+'</div>' +
    statsHtml +
    '<div class="scorebar-wrap">'+bars+'</div>' +
    '<p class="section-label" style="margin-top:10px;">Safety / reputation</p>' +
    safetyNoteHtml;

  document.getElementById('clearSelBtn').addEventListener('click', clearSelection);

  flyTo(type,name);
}

function row(lbl,val){
  return '<div class="stat-row"><span class="lbl">'+lbl+'</span><span class="val">'+val+'</span></div>';
}
function scorebar(lbl,score){
  var s = Math.round(score||0);
  return '<div class="scorebar"><span class="lbl">'+lbl+'</span>' +
    '<div class="track"><div class="fill" style="width:'+s+'%"></div></div>' +
    '<span class="num">'+s+'</span></div>';
}

// ---------- footer ----------
document.getElementById('footNotes').innerHTML =
  'Prices: STATEC / Observatoire de l\u2019Habitat via data.public.lu \u2014 commune layer uses 2020\u201321 notarial/asking prices (relative ranking; Luxembourg-wide levels have shifted since, roughly \u201310 to +5% depending on year), filled with canton averages where a commune had too few sales. Quartier layer uses Immotop.lu quarterly reports (2023\u20132025, mixed vintages, some volatile quarter to quarter). ' +
  'Connectivity: real public-transport service level from Luxembourg\u2019s national GTFS feed (data.public.lu). Every scheduled departure on a representative weekday (Wed 22 Jul 2026) was counted at each stop across all modes \u2014 RGTR + AVL + TICE bus, Luxtram, and CFL rail \u2014 and every stop assigned to its commune/quartier by point-in-polygon against the boundary layers (~360k departures nationally). The score is log-scaled departures/day blended 65/35 with distance-to-capital, so heavily-bused suburbs no longer look disconnected just for lacking a train station, and a rural halt with a handful of daily trains no longer outranks them. Caveat: the current feed covers the summer-holiday period, so school-only lines and some reduced summer schedules understate term-time service in a few rural communes. ' +
  'Amenities: a real census of ~7,700 points of interest from OpenStreetMap (via the Overpass API), replacing the old sampled/estimated model. Every POI is placed by its true coordinates into the correct commune or quartier by point-in-polygon, and sorted into nine categories \u2014 groceries/food shops, restaurants/caf\u00e9s/bars, retail shops, healthcare, pharmacies, schools/childcare, banks/ATMs, gas stations, and parks/sports. The score is a weighted blend of the (log-scaled) count in each category, min-max normalised within each layer, so amenity-dense towns rank high and thin rural communes rank low on real counts rather than a density guess. Each category can be toggled on the map as its own point layer. Caveats: OSM coverage is community-maintained (very good in Luxembourg but not perfect), and \u201cleisure\u201d is deliberately limited to real public parks/sports facilities \u2014 the thousands of private gardens and backyard pools OSM also tags as leisure are excluded. ' +
  'Safety/reputation: Luxembourg publishes no crime statistics below the national level (the police reports are country-wide totals plus an org-chart of 4 police regions \u2014 no per-commune or per-region figures exist), and it is one of the safest countries in the world. So instead of inventing a crime rate everywhere, this layer inverts the problem: every commune and quartier is treated as generally safe (baseline 90/100) unless a specific problem is documented in official sources or the press, in which case it is marked down. Documented markdowns (2024\u201325 review): in the capital, the Gare quartier (22) \u2014 the government\u2019s \u201cDrogend\u00ebsch 2.0\u201d action plan (May 2025) over open drug dealing, homelessness and prostitution around Rue de Strasbourg / Rue Joseph Junck \u2014 plus Hollerich (45) and North/South Bonnevoie (48), the rest of that enforcement zone (35% of all city police patrols); at commune level, Luxembourg (68, hosts those hotspots but is mostly safe), Esch-sur-Alzette (58, documented insecurity and Brill-quarter drug trafficking) and Ettelbruck (72, commissariat made 24/7 under Drogend\u00ebsch). Everywhere else stays at the safe baseline. This means the layer is deliberately near-flat \u2014 that reflects reality \u2014 and it errs toward calling an area safe rather than fabricating suspicion. It is a documented-incident model, not a measured crime rate, so treat a low score as \u201cthere is a known, reported problem here,\u201d not as a precise ranking. ' +
  'Country boundaries are simplified and merged to match the current 100 communes. City quartier boundaries are not the official VDL polygons \u2014 that data exists but wasn\u2019t retrievable from this tool\u2019s sandbox \u2014 they\u2019re a Voronoi tessellation built from each quartier\u2019s real centre point and clipped to the real city outline, so borders are approximate even though the overall shape and coverage are accurate. ' +
  'Transit overlays: three independently-toggleable layers \u2014 bus, tram, and rail \u2014 drawn from real GTFS route geometry (each shape Douglas-Peucker-simplified and de-duplicated into a network of polylines). Cross-border tails toward Trier, Thionville and Arlon are real, not artefacts. Rail additionally shows station markers placed at their real GTFS coordinates \u2014 so they sit on the line \u2014 and sized by scheduled trains/day at each station. The same GTFS data drives the connectivity score above (via departures/day). ' +
  'Score an address: geocoding is Nominatim / OpenStreetMap (Luxembourg only). The dropped pin gets its own scorecard mixing two kinds of factor. Address-level, recomputed at the exact point: transit access — every one of ~2,600 real GTFS stops with service on the sample weekday, its scheduled departures/day discounted by walking distance (weight halves roughly every 280 m) and summed on a saturating 0–100 scale, with the single nearest stop and nearest rail station shown as concrete facts; and amenities — for each of the nine OSM categories, a blend of how many lie within an 800 m walk (log-scaled, capped at a POI-dense urban level) and how far the nearest one is. Commune/quartier-level, inherited because no finer data exists: affordability (price/m²), safety/reputation, and the area’s overall transit service level. The connectivity bar is 60% the address’s own walk-to-transit and 40% the area’s overall service, so a home far from a stop in a well-served commune and one next to a stop in a thin commune both read fairly. The combined score uses the same weight sliders as the map. Caveats: distances are straight-line, not walking-route; the pin inherits its commune’s price rather than the listing’s actual rent; and the GTFS feed is the current summer schedule, so a few term-time school lines are understated.';


// ---------- address scoring ----------
// Hybrid model: transit access and amenities are recomputed from the pin's real
// location (nearest GTFS stops, nearby OSM POIs); affordability, safety and the
// commune's overall connectivity are inherited from the containing commune/quartier
// (no finer data exists for those). Scores land on the same 0-100 scale as the layers.
function haversine(aLat,aLon,bLat,bLon){
  var R=6371000, toR=Math.PI/180;
  var dLat=(bLat-aLat)*toR, dLon=(bLon-aLon)*toR;
  var s=Math.sin(dLat/2)*Math.sin(dLat/2)+
        Math.cos(aLat*toR)*Math.cos(bLat*toR)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return 2*R*Math.asin(Math.sqrt(s));
}
// ray-casting on a single ring of [lon,lat] pairs
function ptInRing(lat,lon,ring){
  var inside=false;
  for(var i=0,j=ring.length-1;i<ring.length;j=i++){
    var xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
    if(((yi>lat)!==(yj>lat)) && (lon<(xj-xi)*(lat-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
function ptInFeature(lat,lon,feature){
  var g=feature.geometry, polys=g.type==='Polygon' ? [g.coordinates] : g.coordinates;
  for(var p=0;p<polys.length;p++){
    var rings=polys[p];
    if(ptInRing(lat,lon,rings[0])){           // in outer ring
      var inHole=false;
      for(var h=1;h<rings.length;h++){ if(ptInRing(lat,lon,rings[h])){ inHole=true; break; } }
      if(!inHole) return true;
    }
  }
  return false;
}
function locateArea(lat,lon){
  var commune=null, quartier=null, i;
  for(i=0;i<COMMUNES_GEOJSON.features.length;i++){
    if(ptInFeature(lat,lon,COMMUNES_GEOJSON.features[i])){ commune=COMMUNES_GEOJSON.features[i].properties.name; break; }
  }
  for(i=0;i<QUARTIERS_GEOJSON.features.length;i++){
    if(ptInFeature(lat,lon,QUARTIERS_GEOJSON.features[i])){ quartier=QUARTIERS_GEOJSON.features[i].properties.name; break; }
  }
  return {commune:commune, quartier:quartier};
}

// Transit access: sum every stop's daily departures, discounted by walking distance
// (weight halves ~every 280 m), on a saturating 0-100 scale. Also returns the nearest
// stop and nearest rail station as concrete facts to show alongside the score.
function transitAccess(lat,lon){
  var a=0, nearest=null, nd=Infinity, nrail=null, nrd=Infinity, s, d;
  var S=TRANSIT_STOPS.stops;
  for(var i=0;i<S.length;i++){
    s=S[i]; d=haversine(lat,lon,s[0],s[1]);
    if(d<1500) a+=s[3]*Math.exp(-d/400);
    if(d<nd){ nd=d; nearest=s; }
    if(s[2]==='r' && d<nrd){ nrd=d; nrail=s; }
  }
  return { score: Math.round(100*(1-Math.exp(-a/1800))),
           nearest:nearest, ndist:nd, nrail:nrail, nrdist:nrd };
}

// Amenities: for each category, blend density (log-scaled count within an 800 m walk,
// capped at a POI-rich urban level) with proximity (distance to the nearest one).
var AMEN_CAP = {grocery:26, dining:115, retail:93, health:14, pharmacy:4, school:12, bank:14, fuel:2, leisure:16};
var AMEN_W   = {grocery:.18, pharmacy:.12, health:.12, school:.12, dining:.10, retail:.08, bank:.08, leisure:.10, fuel:.06};
function amenityLocal(lat,lon){
  var cats={}, wsum=0, acc=0, c, pts, cnt, near, d, dens, prox, cs, i;
  for(c in AMENITIES_POI){
    pts=AMENITIES_POI[c]; cnt=0; near=Infinity;
    for(i=0;i<pts.length;i++){ d=haversine(lat,lon,pts[i][0],pts[i][1]); if(d<800)cnt++; if(d<near)near=d; }
    dens=Math.min(1, Math.log(1+cnt)/Math.log(1+(AMEN_CAP[c]||10)));
    prox=Math.max(0, Math.min(1, 1-near/800));
    cs=0.5*dens+0.5*prox;
    cats[c]={cnt:cnt, near:near, cs:cs};
    var w=AMEN_W[c]||0; wsum+=w; acc+=w*cs;
  }
  return { score: Math.round(100*acc/wsum), cats:cats };
}

function computeAddress(lat,lon){
  var loc=locateArea(lat,lon);
  var area = loc.quartier ? {type:'quartier', name:loc.quartier, obj:QUARTIERS[loc.quartier]}
           : (loc.commune ? {type:'commune',  name:loc.commune,  obj:COMMUNES[loc.commune]} : null);
  var ta=transitAccess(lat,lon), am=amenityLocal(lat,lon);
  var afford = area ? area.obj.score_afford : null;
  var safety = area ? getSafetyScore(area.type, area.name, area.obj) : 90;
  var commuteConnect = area ? area.obj.score_connect : null;
  // connectivity factor = 60% this address's walk-to-transit + 40% the area's overall service
  var connect = commuteConnect!=null ? Math.round(0.6*ta.score + 0.4*commuteConnect) : ta.score;
  return { lat:lat, lon:lon, loc:loc, area:area,
           transit:ta, amenity:am,
           afford:afford, safety:safety, connect:connect, communeConnect:commuteConnect };
}
function addressCombined(r){
  var w=state.weights, num=0, den=0;
  if(r.afford!=null){ num+=r.afford*w.afford; den+=w.afford; }
  num+=r.connect*w.connect; den+=w.connect;
  num+=r.amenity.score*w.amenity; den+=w.amenity;
  num+=r.safety*w.safety; den+=w.safety;
  return den>0 ? num/den : 50;
}

function fmtDist(m){ return m<1000 ? Math.round(m)+' m' : (m/1000).toFixed(1)+' km'; }
function modeName(m){ return m==='r'?'rail':(m==='t'?'tram':'bus'); }

function popBar(label, score, srcTag){
  var s=Math.round(score);
  return '<div class="pop-bar"><span class="bl">'+label+'</span>'+
    '<span class="bt"><span class="bf" style="width:'+s+'%;background:'+scoreToColor(s)+'"></span></span>'+
    '<span class="bn">'+s+'</span><span class="src">'+srcTag+'</span></div>';
}
function addressPopupHTML(r){
  var combined=addressCombined(r);
  var locLine = r.area
    ? (r.loc.quartier ? r.loc.quartier+' &middot; Luxembourg City' : r.loc.commune+' commune')
    : 'outside the mapped communes';
  var af = r.afford!=null ? popBar('Afford.', r.afford, 'area') : '';
  var bars = af +
    popBar('Connect.', r.connect, 'addr') +
    popBar('Amenities', r.amenity.score, 'addr') +
    popBar('Safety', r.safety, 'area');

  var ta=r.transit, ac=r.amenity.cats;
  var nearStop = ta.nearest
    ? fmtDist(ta.ndist)+' &middot; '+ta.nearest[3]+'/day '+modeName(ta.nearest[2])
    : '—';
  var railFact = ta.nrail ? fmtDist(ta.nrdist)+' &middot; '+ta.nrail[3]+' trains/day' : 'none nearby';
  function amFact(c){ var o=ac[c]; return o.cnt+' &middot; nearest '+(o.near<800?Math.round(o.near)+' m':'>800 m'); }

  var facts=
    '<div class="pop-fact"><span class="fl">Nearest stop</span><span class="fv">'+nearStop+'</span></div>'+
    '<div class="pop-fact"><span class="fl">Nearest rail</span><span class="fv">'+railFact+'</span></div>'+
    '<div class="pop-fact"><span class="fl">Groceries ≤800m</span><span class="fv">'+amFact('grocery')+'</span></div>'+
    '<div class="pop-fact"><span class="fl">Pharmacy ≤800m</span><span class="fv">'+amFact('pharmacy')+'</span></div>'+
    '<div class="pop-fact"><span class="fl">Schools ≤800m</span><span class="fv">'+amFact('school')+'</span></div>'+
    '<div class="pop-fact"><span class="fl">Dining ≤800m</span><span class="fv">'+amFact('dining')+'</span></div>';

  var priceStr = (r.area && r.area.obj.price_m2) ? ' · ~'+r.area.obj.price_m2.toLocaleString('en-US')+' €/m²' : '';
  var note = r.area
    ? 'Connectivity &amp; amenities computed at this point; affordability'+priceStr+', safety and commune service inherited from '+(r.loc.quartier||r.loc.commune)+'.'
    : 'Point falls outside the mapped communes — affordability unavailable; safety shown at the national baseline.';

  return '<div class="pop-addr">'+ (r.label||'Dropped pin') +'</div>'+
    '<div class="pop-loc">'+locLine+'</div>'+
    '<div class="pop-combined">'+
      '<div class="pop-chip" style="background:'+scoreToColor(combined)+'">'+Math.round(combined)+'</div>'+
      '<div><div class="cl">Combined score</div><div class="cv">weighted by your sliders — afford / connect / amenity / safety</div></div>'+
    '</div>'+
    bars +
    '<div class="pop-facts">'+facts+'</div>'+
    '<div class="pop-note">'+note+'</div>';
}

// ---------- address pin control ----------
var addrMarker=null, addrResult=null;
function pinIcon(score){
  return L.divIcon({
    className:'', iconSize:[30,30], iconAnchor:[15,30], popupAnchor:[0,-28],
    html:'<div class="addr-pin" style="background:'+scoreToColor(score)+'"><span>'+Math.round(score)+'</span></div>'
  });
}
function refreshAddrPopup(){
  if(!addrMarker || !addrResult) return;
  addrResult.label = addrResult.label; // keep
  var combined=addressCombined(addrResult);
  addrMarker.setIcon(pinIcon(combined));
  var pop=addrMarker.getPopup();
  if(pop) pop.setContent(addressPopupHTML(addrResult));
}
function placePin(lat,lon,label){
  addrResult = computeAddress(lat,lon);
  addrResult.label = label;
  var combined = addressCombined(addrResult);
  if(addrMarker){
    addrMarker.setLatLng([lat,lon]).setIcon(pinIcon(combined));
  } else {
    addrMarker = L.marker([lat,lon], {icon:pinIcon(combined), draggable:true, zIndexOffset:1000});
    // the popup opens upward and is tall; pad the top generously so auto-pan keeps it
    // clear of the fixed page header (which Leaflet's auto-pan is unaware of)
    addrMarker.bindPopup('', {className:'lx-pop', maxWidth:260,
      autoPanPaddingTopLeft:[24,96], autoPanPaddingBottomRight:[24,24]});
    addrMarker.on('dragend', function(){
      var ll=addrMarker.getLatLng();
      var lbl=addrResult ? addrResult.label : 'Dropped pin';
      addrResult = computeAddress(ll.lat, ll.lng);
      addrResult.label = lbl+' (moved)';
      addrMarker.setIcon(pinIcon(addressCombined(addrResult)));
      addrMarker.getPopup().setContent(addressPopupHTML(addrResult));
      addrMarker.openPopup();
    });
    addrMarker.addTo(map);
  }
  addrMarker.getPopup().setContent(addressPopupHTML(addrResult));
  // open the popup only after the fly settles, so auto-pan positions it correctly
  // rather than fighting the fly animation
  map.once('moveend', function(){ if(addrMarker) addrMarker.openPopup(); });
  map.flyTo([lat,lon], Math.max(map.getZoom(),14), {duration:0.6});
}

// keep an open pin's combined score in sync with the weight sliders
['Afford','Connect','Amenity','Safety'].forEach(function(key){
  var input=document.getElementById('w'+key);
  if(input) input.addEventListener('input', refreshAddrPopup);
});

(function initAddressSearch(){
  var input=document.getElementById('addrInput');
  var btn=document.getElementById('addrBtn');
  var status=document.getElementById('addrStatus');
  if(!input||!btn) return;
  function setStatus(msg,isErr){ status.textContent=msg; status.className='addr-status'+(isErr?' err':''); }
  function search(){
    var q=input.value.trim();
    if(!q){ setStatus('Enter an address first.', true); return; }
    btn.disabled=true; setStatus('Searching…', false);
    var url='https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=lu&addressdetails=1&q='+encodeURIComponent(q);
    fetch(url, {headers:{'Accept':'application/json'}})
      .then(function(res){ if(!res.ok) throw new Error('geocoder '+res.status); return res.json(); })
      .then(function(list){
        if(!list || !list.length){ setStatus('No match in Luxembourg. Try adding the town or postcode.', true); btn.disabled=false; return; }
        var hit=list[0];
        var lat=parseFloat(hit.lat), lon=parseFloat(hit.lon);
        var label=(hit.display_name||q).split(',').slice(0,2).join(',').trim();
        var loc=locateArea(lat,lon);
        if(!loc.commune){ setStatus('Found a location, but it is outside the mapped communes. Pin dropped anyway — drag it onto Luxembourg.', true); }
        else { setStatus('Pinned in '+(loc.quartier||loc.commune)+'. Drag the pin to fine-tune the exact building.', false); }
        placePin(lat,lon,label);
        btn.disabled=false;
      })
      .catch(function(err){ setStatus('Geocoding failed ('+err.message+'). Check your connection and retry.', true); btn.disabled=false; });
  }
  btn.addEventListener('click', search);
  input.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); search(); } });
})();

// ---------- init ----------
renderAll();

})();
