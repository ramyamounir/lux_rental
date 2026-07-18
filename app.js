(function(){
"use strict";

// ---------- state ----------
var state = {
  view: 'country',      // 'country' | 'city'
  layer: 'combined',    // 'combined' | 'afford' | 'connect' | 'amenity' | 'safety'
  selected: null,       // {type, name}
  weights: {afford:35, connect:30, amenity:20, safety:15}
};
var safetyRatings = {}; // key: type_slug -> 1..5

function slug(name){ return name.replace(/\s+/g,'_'); }
function ratingKey(type,name){ return 'safety_' + type + '_' + slug(name); }

// ---------- storage ----------
async function loadAllSafetyRatings(){
  if(!window.storage) return;
  try{
    var list = await window.storage.list('safety_', false);
    if(list && list.keys){
      for(var i=0;i<list.keys.length;i++){
        var k = list.keys[i];
        try{
          var r = await window.storage.get(k, false);
          if(r && r.value!=null) safetyRatings[k] = JSON.parse(r.value);
        }catch(e){ /* ignore missing */ }
      }
    }
  }catch(e){ console.warn('safety ratings load skipped', e); }
  renderAll();
}

async function setSafetyRating(type,name,val){
  var key = ratingKey(type,name);
  safetyRatings[key] = val;
  if(window.storage){
    try{ await window.storage.set(key, JSON.stringify(val), false); }
    catch(e){ console.warn('could not save rating', e); }
  }
  renderAll();
}

async function clearSafetyRating(type,name){
  var key = ratingKey(type,name);
  delete safetyRatings[key];
  if(window.storage){
    try{ await window.storage.delete(key, false); }catch(e){}
  }
  renderAll();
}

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
function getSafetyScore(type,name,obj){
  var userRating = safetyRatings[ratingKey(type,name)];
  if(userRating!=null) return (userRating-1)/4*100;
  if(obj && obj.score_safety!=null) return obj.score_safety;
  return null;
}
function combinedScore(obj,type,name){
  var w = state.weights;
  var total = w.afford + w.connect + w.amenity + w.safety;
  if(total<=0) return 50;
  var safetyVal = getSafetyScore(type,name,obj);
  var safetyForCalc = safetyVal==null ? 50 : safetyVal;
  return (obj.score_afford*w.afford + obj.score_connect*w.connect +
          obj.score_amenity*w.amenity + safetyForCalc*w.safety) / total;
}
function scoreFor(obj,type,name,layer){
  if(layer==='afford') return obj.score_afford;
  if(layer==='connect') return obj.score_connect;
  if(layer==='amenity') return obj.score_amenity;
  if(layer==='safety'){ var s=getSafetyScore(type,name,obj); return s==null?50:s; }
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
var contextLayer = L.geoJSON(COMMUNES_GEOJSON, {
  style: function(){ return {fillColor:'#1a2029', fillOpacity:1, weight:0.6, color:'#262e38'}; },
  interactive:false
});

// The city commune's own outline, drawn brighter on top of the context layer
// while in city view.
var cityFeature = null;
for(var i=0;i<COMMUNES_GEOJSON.features.length;i++){
  if(COMMUNES_GEOJSON.features[i].properties.name==='Luxembourg'){ cityFeature = COMMUNES_GEOJSON.features[i]; break; }
}
var cityBoundaryLayer = L.geoJSON(cityFeature, {
  style: function(){ return {fillColor:'#20293a', fillOpacity:1, weight:1.5, color:'#46536a'}; },
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
function quartierStyle(feature){
  var name = feature.properties.name;
  var obj = QUARTIERS[name];
  var s = obj ? scoreFor(obj,'quartier',name,state.layer) : 50;
  return {fillColor: scoreToColor(s), weight:1, color:'#12161d', fillOpacity:0.85};
}

function communeStyle(feature){
  var name = feature.properties.name;
  var obj = COMMUNES[name];
  var s = obj ? scoreFor(obj,'commune',name,state.layer) : 50;
  return {fillColor: scoreToColor(s), weight:1, color:'#12161d', fillOpacity:0.85};
}

function fitCountry(){
  try{ map.fitBounds(communeLayer.getBounds(), {padding:[8,8]}); }
  catch(e){ map.setView([49.73,6.12],9); }
}
function fitCity(){
  try{ map.fitBounds(cityBoundaryLayer.getBounds(), {padding:[18,18]}); }
  catch(e){ map.setView([49.612,6.128], 13); }
}

// ---------- transit overlay ----------
// Real CFL stations (with 2022 ridership) and the Luxtram line, positioned at
// commune/quartier centroids (exact per-station coordinates weren't available)
// and connected in their real line order. This is schematic routing between
// real points, not surveyed track geometry. No bus data: see footer note.
var RAIL_LINES = [
  ['Luxembourg','Walferdange','Lorentzweiler','Lintgen','Mersch','Colmar-Berg','Schieren','Ettelbruck','Bourscheid','Kiischpelt','Clervaux','Troisvierges'],
  ['Ettelbruck','Diekirch'],
  ['Kiischpelt','Wiltz'],
  ['Luxembourg','Schuttrange','Contern','Betzdorf','Biwer','Manternach','Mertert'],
  ['Luxembourg','Bertrange','Mamer','Steinfort'],
  ['Luxembourg','Hesperange','Roeser','Bettembourg','Schifflange','Esch-sur-Alzette','Sanem','Differdange','Pétange'],
  ['Bettembourg','Dudelange'],
  ['Schifflange','Kayl','Rumelange'],
  ['Luxembourg','Leudelange','Dippach','Käerjeng','Pétange']
];
var TRAM_QUARTIERS = ['Kirchberg','Pfaffenthal','Ville Haute','Gare','North Bonnevoie-Verlorenkost','Gasperich'];

var transitGroup = L.layerGroup();
(function buildTransitOverlay(){
  // rail lines (schematic polylines through commune centroids)
  RAIL_LINES.forEach(function(line){
    var pts = line.map(function(n){ return COMMUNES[n] ? [COMMUNES[n].centroid[0], COMMUNES[n].centroid[1]] : null; })
                   .filter(function(p){ return p; });
    if(pts.length>1){
      L.polyline(pts, {color:'#6fa8c9', weight:2.2, opacity:0.7, dashArray:'1,6', lineCap:'round', interactive:false}).addTo(transitGroup);
    }
  });
  // rail stations (real ridership, sized log-scale)
  var maxPax = 0;
  for(var n in COMMUNES){ if(COMMUNES[n].rail_passengers_2022>maxPax) maxPax = COMMUNES[n].rail_passengers_2022; }
  for(var name in COMMUNES){
    var c = COMMUNES[name];
    if(!c.has_rail_station) continue;
    var r = 3 + 7*(Math.log10(c.rail_passengers_2022+1)/Math.log10(maxPax+1));
    var m = L.circleMarker([c.centroid[0], c.centroid[1]], {
      radius:r, weight:1.2, color:'#12161d', fillColor:'#6fa8c9', fillOpacity:0.95
    });
    m.bindTooltip(name+' \u2014 '+c.rail_passengers_2022.toLocaleString('en-US')+' riders/yr (2022)', {sticky:true, className:'lx-tip'});
    m.on('click', function(e){ L.DomEvent.stopPropagation(e); });
    m.addTo(transitGroup);
  }
  // tram line + stops
  var tramPts = TRAM_QUARTIERS.map(function(n){ return QUARTIERS[n] ? [QUARTIERS[n].lat, QUARTIERS[n].lon] : null; }).filter(function(p){ return p; });
  if(tramPts.length>1){
    L.polyline(tramPts, {color:'#d9789f', weight:2.6, opacity:0.85, lineCap:'round', interactive:false}).addTo(transitGroup);
  }
  TRAM_QUARTIERS.forEach(function(name){
    var q = QUARTIERS[name];
    if(!q) return;
    var m = L.circleMarker([q.lat, q.lon], {radius:4.5, weight:1.2, color:'#12161d', fillColor:'#d9789f', fillOpacity:0.95});
    m.bindTooltip(name+' \u2014 Luxtram stop (schematic)', {sticky:true, className:'lx-tip'});
    m.on('click', function(e){ L.DomEvent.stopPropagation(e); });
    m.addTo(transitGroup);
  });
})();

var transitToggle = document.getElementById('transitToggle');
var transitLegend = document.getElementById('transitLegend');
transitToggle.addEventListener('change', function(){
  if(transitToggle.checked){ transitGroup.addTo(map); transitLegend.style.display='flex'; }
  else { map.removeLayer(transitGroup); transitLegend.style.display='none'; }
});

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
    layerTabs.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    state.layer = btn.getAttribute('data-layer');
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
  amenity:'Most amenities (density proxy)',
  safety:'Safest (data + your ratings)'
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
  var amenityRow = obj.grocery_count!=null
      ? row('Nearby (sampled)', obj.grocery_count+' grocery, '+obj.dine_count+' dining/entertainment')
      : row('Nearby (sampled)', 'none found \u2014 density-based estimate used');
  if(type==='commune'){
    subLine = obj.canton + ' canton \u00b7 ' + obj.dist_to_capital_km + ' km from Luxembourg City centre';
    statsHtml =
      row('Population', obj.population.toLocaleString('en-US')) +
      row('Density', obj.density.toLocaleString('en-US')+' /km\u00b2') +
      row('Price', fmtPrice(obj.price_m2)) +
      row('Price source', obj.price_source + (obj.price_estimated?' (canton avg. fallback)':'')) +
      amenityRow +
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
      (obj.rail_passengers_2022 ? row('Rail riders (2022)', obj.rail_passengers_2022.toLocaleString('en-US')+'/yr') : '');
  }

  var combined = combinedScore(obj, type, name);
  var effSafety = getSafetyScore(type, name, obj);
  var bars =
    scorebar('Afford.', obj.score_afford) +
    scorebar('Connect.', obj.score_connect) +
    scorebar('Amenities', obj.score_amenity) +
    scorebar('Safety', effSafety==null ? 50 : effSafety) +
    scorebar('Combined', combined);

  var curRating = safetyRatings[ratingKey(type,name)] || 0;
  var safetyNoteHtml = '';
  if(obj.safety_source){
    safetyNoteHtml = '<div class="sub" style="margin:6px 0 10px 0; line-height:1.5;">' +
      (obj.score_safety!=null ? '<b style="color:var(--gold-bright);font-family:\'IBM Plex Mono\';">'+Math.round(obj.score_safety)+'/100</b> \u2014 ' : '') +
      obj.safety_source + '</div>';
  } else {
    safetyNoteHtml = '<div class="sub" style="margin:6px 0 10px 0;">No public safety/crime data found for this area \u2014 rate it yourself below.</div>';
  }

  var starsHtml = '<div class="stars">';
  for(var i=1;i<=5;i++){
    starsHtml += '<button data-n="'+i+'" class="'+(i<=curRating?'on':'')+'">\u2605</button>';
  }
  starsHtml += '</div>';
  if(curRating>0) starsHtml += '<button class="clear-rating" id="clearRatingBtn">clear rating</button>';

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
    safetyNoteHtml +
    '<p class="section-label">Your rating (overrides the above in the combined score, saved on this device)</p>' +
    starsHtml;

  document.getElementById('clearSelBtn').addEventListener('click', clearSelection);

  det.querySelectorAll('.stars button').forEach(function(btn){
    btn.addEventListener('click', function(){
      var n = parseInt(btn.getAttribute('data-n'),10);
      setSafetyRating(type,name,n);
    });
  });
  var clearBtn = document.getElementById('clearRatingBtn');
  if(clearBtn) clearBtn.addEventListener('click', function(){ clearSafetyRating(type,name); });

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
  'Connectivity: for the ~39 communes with a CFL train station, this is real 2022 station ridership (Wikipedia/CFL, log-scaled, summed where a commune has several stations) blended 62/38 with distance-to-capital; communes with no station are scored on distance alone. It measures how easily a commune reaches Luxembourg City by rail, not how many stops a local bus network has \u2014 no public bus-stop-location or GTFS-frequency dataset was reachable from this tool (the official GTFS feed and OSM/Overpass are both on domains this sandbox can\u2019t fetch), so local bus density inside a commune is not modelled. ' +
  'Amenities: real grocery-store and dining/entertainment counts from Google Places, geometrically matched to the correct commune or quartier (not just wherever the search happened to be aimed \u2014 results spill across boundaries, so every place was placed by its real coordinates). This only covers a sampled subset \u2014 the ~35 largest communes and the busiest few quartiers \u2014 not an exhaustive census; smaller places may have local shops this sample missed. Areas with no sampled data get an estimate from the (weak, R\u00b2\u22480.24) relationship between population density and amenity count observed in the sampled areas, clearly marked as such in each area\u2019s detail panel. ' +
  'Safety/reputation: no official Luxembourg crime dataset is published below the national level, so this blends two real sources \u2014 Numbeo\u2019s crowdsourced Safety Index (perception survey, shown with its contributor count; only ~10 communes have enough responses to be meaningful, mostly the larger towns) and, for Luxembourg City, the government\u2019s own 2025 \u201cDrogend\u00ebsch 2.0\u201d anti-drug plan, which names Gare, Bonnevoie and Hollerich as a documented hotspot (35% of city police patrols concentrated there). Everywhere else has no data \u2014 rate it yourself to fold your own judgment into the combined score; your rating always overrides the public data where both exist, and is stored only on this device. ' +
  'Country boundaries are simplified and merged to match the current 100 communes. City quartier boundaries are not the official VDL polygons \u2014 that data exists but wasn\u2019t retrievable from this tool\u2019s sandbox \u2014 they\u2019re a Voronoi tessellation built from each quartier\u2019s real centre point and clipped to the real city outline, so borders are approximate even though the overall shape and coverage are accurate. ' +
  'Transit overlay: rail stations and their sizes are real (2022 CFL passenger counts), but plotted at commune/quartier centroids rather than surveyed station coordinates, and the lines connecting them follow the real line sequence schematically rather than actual track geometry. Bus (RGTR/AVL) isn\u2019t shown at all \u2014 the national GTFS feed and OpenStreetMap/Overpass, the two sources that would have it, are both on domains this sandbox can\u2019t reach.';


// ---------- init ----------
loadAllSafetyRatings();
renderAll();

})();
