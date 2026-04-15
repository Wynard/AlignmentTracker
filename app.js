require([
  "esri/Map",
  "esri/views/MapView",
  "esri/Graphic",
  "esri/layers/GraphicsLayer",
  "esri/layers/FeatureLayer",
  "esri/geometry/geometryEngine",
  "esri/geometry/Point",
  "esri/geometry/Polyline",
  "esri/geometry/projection",
  "esri/symbols/SimpleLineSymbol",
  "esri/symbols/SimpleMarkerSymbol",
  "esri/symbols/SimpleFillSymbol"
], function(
  Map,
  MapView,
  Graphic,
  GraphicsLayer,
  FeatureLayer,
  geometryEngine,
  Point,
  Polyline,
  projection,
  SimpleLineSymbol,
  SimpleMarkerSymbol,
  SimpleFillSymbol
) {
  const PUBLIC_LAYER_URL = "https://services-eu1.arcgis.com/GdMgNbOLlUGHT4ZK/arcgis/rest/services/Ax_Dan/FeatureServer/0";

  // --- State ---
  let allAlignments = [];
  let filteredAlignments = [];
  let selectedAlignment = null;
  let gpsWatchId = null;
  let userGraphic = null;
  let nearestGraphic = null;
  let connectLineGraphic = null;
  let projectionReady = false;
  let currentBasemapMode = "map";
  let activeMode = "track";
  let stakeoutTarget = null;
  let targetGraphic = null;
  let stakeoutLineGraphic = null;
  // GPS accuracy & smoothing
  let lastAccuracy = Infinity;
  let smoothedPoint = null;
  let wasArrived = false;
  let lastRawMapPt = null;
  let accuracyGraphic = null;
  let wakeLock = null;
  const GPS_ALPHA = 0.4;

  // --- Element refs ---
  const projectSelect = document.getElementById("projectSelect");
  const alignmentSelect = document.getElementById("alignmentSelect");
  const alignmentNameEl = document.getElementById("alignmentName");
  const stationDisplayEl = document.getElementById("stationDisplay");
  const primaryMetricLabelEl = document.getElementById("primaryMetricLabel");
  const secondaryMetricLabelEl = document.getElementById("secondaryMetricLabel");
  const chainageValueEl = document.getElementById("chainageValue");
  const offsetValueEl = document.getElementById("offsetValue");
  const offsetDirEl = document.getElementById("offsetDir");
  const statusMsgEl = document.getElementById("statusMsg");
  const gpsIndicatorEl = document.getElementById("gpsIndicator");
  const btnBasemapEl = document.getElementById("btnBasemap");
  const btnTrackModeEl = document.getElementById("btnTrackMode");
  const btnStakeoutModeEl = document.getElementById("btnStakeoutMode");
  const stakeoutRowEl = document.getElementById("stakeoutRow");
  const stakeoutInputEl = document.getElementById("stakeoutInput");
  const gpsAccuracyEl = document.getElementById("gpsAccuracy");

  const basemapModes = {
    map: "dark-gray-vector",
    satellite: "hybrid"
  };

  // --- Utilities ---
  function log(msg) {
    console.log(msg);
    const el = document.getElementById("debugLog");
    el.innerHTML += msg + "<br>";
    el.scrollTop = el.scrollHeight;
  }

  window.toggleDebug = function() {
    document.getElementById("debugLog").classList.toggle("visible");
  };

  function setStatus(message) {
    statusMsgEl.textContent = message;
  }

  function applyBasemapMode(mode) {
    currentBasemapMode = mode;
    map.basemap = basemapModes[mode];
    btnBasemapEl.textContent = mode === "map" ? "Satellite" : "Map";
    btnBasemapEl.classList.toggle("active", mode === "satellite");
  }

  function formatChainage(meters, precision) {
    if (!Number.isFinite(meters)) return "--";
    const p = precision || 0;
    const sign = meters < 0 ? "-" : "";
    const abs = Math.abs(meters);
    const km = Math.floor(abs / 1000);
    const m = abs % 1000;
    if (p === 0) {
      return sign + km + "+" + String(Math.round(m)).padStart(3, "0");
    }
    const mFixed = m.toFixed(p);
    const mParts = mFixed.split(".");
    return sign + km + "+" + String(mParts[0]).padStart(3, "0") + "." + mParts[1];
  }

  function updateAccuracyDisplay(accuracy) {
    lastAccuracy = accuracy;
    if (!gpsAccuracyEl) return;
    gpsAccuracyEl.textContent = "\u00b1" + Math.round(accuracy) + "m";
    gpsAccuracyEl.className = "gps-accuracy " + (accuracy <= 5 ? "good" : accuracy <= 15 ? "warn" : "bad");
  }

  function bearingToTarget(fromPt, toPt) {
    const dx = toPt.x - fromPt.x;
    const dy = toPt.y - fromPt.y;
    const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    const cardinals = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const cardinal = cardinals[Math.round(deg / 45) % 8];
    return cardinal + " " + Math.round(deg) + "\u00b0";
  }

  function normalizeProjectName(value) {
    return String(value == null ? "" : value).trim() || "Unassigned";
  }

  function normalizeAlignmentName(value, fallbackIndex) {
    return String(value == null ? "" : value).trim() || ("Alignment " + fallbackIndex);
  }

  function showStationDisplay() {
    stationDisplayEl.style.display = "flex";
  }

  function hideStationDisplay() {
    stationDisplayEl.style.display = "none";
  }

  function resetComputedValues() {
    chainageValueEl.innerHTML = "&mdash;";
    offsetValueEl.innerHTML = "&mdash;";
    offsetDirEl.textContent = "m";
  }

  function resetComputedDisplay() {
    hideStationDisplay();
    resetComputedValues();
  }

  function clearTrackGraphics() {
    if (nearestGraphic) {
      trackingLayer.remove(nearestGraphic);
      nearestGraphic = null;
    }
    if (connectLineGraphic) {
      trackingLayer.remove(connectLineGraphic);
      connectLineGraphic = null;
    }
  }

  function clearStakeoutGraphics() {
    if (targetGraphic) {
      trackingLayer.remove(targetGraphic);
      targetGraphic = null;
    }
    if (stakeoutLineGraphic) {
      trackingLayer.remove(stakeoutLineGraphic);
      stakeoutLineGraphic = null;
    }
  }

  function clearStakeoutTarget(clearInput) {
    stakeoutTarget = null;
    wasArrived = false;
    const distCard = stationDisplayEl.querySelector(".metric-card:last-child");
    if (distCard) distCard.classList.remove("arrived");
    clearStakeoutGraphics();
    if (clearInput) {
      stakeoutInputEl.value = "";
    }
  }

  function collapseHud() {
    document.getElementById("hudInner").classList.remove("expanded");
  }

  function expandHud() {
    document.getElementById("hudInner").classList.add("expanded");
  }

  window.toggleHud = function() {
    document.getElementById("hudInner").classList.toggle("expanded");
  };

  function setMetricMode(mode) {
    primaryMetricLabelEl.textContent = mode === "track" ? "Chainage" : "Target KM";
    secondaryMetricLabelEl.textContent = mode === "track" ? "Offset" : "Distance";
  }

  function clearSelection(statusMessage) {
    selectedAlignment = null;
    alignmentNameEl.textContent = "No alignment selected";
    alignmentSelect.value = "";
    clearStakeoutTarget(true);
    resetComputedDisplay();
    clearTrackGraphics();
    filteredAlignments.forEach(function(alignment) {
      alignment.graphic.symbol = alignmentSym;
    });
    expandHud();
    if (statusMessage) {
      setStatus(statusMessage);
    }
  }

  function computeCumDists(polyline) {
    const path = polyline.paths[0];
    const dists = [0];
    for (let i = 1; i < path.length; i += 1) {
      const seg = new Polyline({
        paths: [[path[i - 1].slice(0, 2), path[i].slice(0, 2)]],
        spatialReference: polyline.spatialReference
      });
      dists.push(dists[i - 1] + geometryEngine.geodesicLength(seg, "meters"));
    }
    return dists;
  }

  function mergePaths(geometry) {
    const mergedPath = [];
    geometry.paths.forEach(function(path) {
      path.forEach(function(vertex) {
        const prev = mergedPath[mergedPath.length - 1];
        const isDuplicate = prev && prev[0] === vertex[0] && prev[1] === vertex[1];
        if (!isDuplicate) {
          mergedPath.push(vertex);
        }
      });
    });

    return new Polyline({
      paths: [mergedPath],
      spatialReference: geometry.spatialReference
    });
  }

  function createAlignmentModel(feature, index) {
    if (!feature.geometry || !feature.geometry.paths || !feature.geometry.paths.length) {
      return null;
    }

    const geometry = mergePaths(feature.geometry);
    if (!geometry.paths[0] || geometry.paths[0].length < 2) {
      return null;
    }

    const attributes = feature.attributes || {};
    const cumDists = computeCumDists(geometry);
    const model = {
      id: attributes.FID,
      name: normalizeAlignmentName(attributes.Nume_Ax, index + 1),
      project: normalizeProjectName(attributes.Proiect),
      startMeter: Number(attributes.Start_Meter || 0),
      geometry: geometry,
      cumDists: cumDists
    };

    model.graphic = new Graphic({
      geometry: geometry,
      symbol: alignmentSym,
      attributes: {
        _alignmentId: model.id
      }
    });

    return model;
  }

  async function queryAllFeatures(layer) {
    const objectIdField = layer.objectIdField || "FID";
    const pageSize = layer.maxRecordCount || 2000;
    const totalQuery = layer.createQuery();
    totalQuery.where = "1=1";

    const total = await layer.queryFeatureCount(totalQuery);
    const features = [];

    for (let offset = 0; offset < total; offset += pageSize) {
      const query = layer.createQuery();
      query.where = "1=1";
      query.outFields = ["FID", "Proiect", "Nume_Ax", "Start_Meter"];
      query.returnGeometry = true;
      query.outSpatialReference = view.spatialReference;
      query.orderByFields = [objectIdField + " ASC"];
      query.start = offset;
      query.num = pageSize;

      const result = await layer.queryFeatures(query);
      features.push.apply(features, result.features);
    }

    return features;
  }

  function zoomToAlignments(alignments) {
    const targets = alignments.map(function(alignment) {
      return alignment.graphic;
    });

    if (!targets.length) {
      return;
    }

    view.goTo(targets, { animate: true, duration: 500 }).catch(function() {
      return null;
    });
  }

  function renderFilteredAlignments() {
    alignmentLayer.removeAll();
    filteredAlignments.forEach(function(alignment) {
      alignment.graphic.symbol = selectedAlignment && selectedAlignment.id === alignment.id ? selectedSym : alignmentSym;
      alignmentLayer.add(alignment.graphic);
    });
  }

  function populateProjectOptions() {
    const projectNames = Array.from(new Set(allAlignments.map(function(alignment) {
      return alignment.project;
    }))).sort(function(a, b) {
      return a.localeCompare(b);
    });

    projectSelect.innerHTML = '<option value="">Select project</option>';
    projectNames.forEach(function(projectName) {
      const option = document.createElement("option");
      option.value = projectName;
      option.textContent = projectName;
      projectSelect.appendChild(option);
    });
  }

  function populateAlignmentOptions() {
    alignmentSelect.innerHTML = "";

    if (!projectSelect.value) {
      alignmentSelect.disabled = true;
      alignmentSelect.innerHTML = '<option value="">Select a project first</option>';
      return;
    }

    alignmentSelect.disabled = false;
    alignmentSelect.innerHTML = '<option value="">Select alignment</option>';

    filteredAlignments
      .slice()
      .sort(function(a, b) {
        return a.name.localeCompare(b.name);
      })
      .forEach(function(alignment) {
        const option = document.createElement("option");
        option.value = String(alignment.id);
        option.textContent = alignment.name;
        alignmentSelect.appendChild(option);
      });
  }

  function applyProjectFilter(projectName) {
    filteredAlignments = projectName
      ? allAlignments.filter(function(alignment) {
          return alignment.project === projectName;
        })
      : allAlignments.slice();

    if (!selectedAlignment || !filteredAlignments.some(function(alignment) { return alignment.id === selectedAlignment.id; })) {
      clearSelection(projectName ? "Select an alignment." : "Select a project.");
    }

    populateAlignmentOptions();
    renderFilteredAlignments();
    zoomToAlignments(filteredAlignments);

    if (!projectName) {
      return;
    }

    if (selectedAlignment) {
      alignmentSelect.value = String(selectedAlignment.id);
      setStatus("Selected " + selectedAlignment.name + " in " + selectedAlignment.project + ".");
      return;
    }

    if (filteredAlignments.length === 1) {
      selectAlignment(filteredAlignments[0]);
      return;
    }

    setStatus(filteredAlignments.length + " alignments available in " + projectName + ".");
  }

  function selectAlignment(alignment) {
    const previousAlignmentId = selectedAlignment ? selectedAlignment.id : null;
    selectedAlignment = alignment;
    alignmentNameEl.textContent = alignment.name;
    showStationDisplay();
    alignmentSelect.value = String(alignment.id);
    renderFilteredAlignments();
    clearTrackGraphics();
    if (previousAlignmentId !== alignment.id) {
      clearStakeoutTarget(true);
      smoothedPoint = null;
    }
    collapseHud();
    if (activeMode === "stakeout") {
      refreshModeDisplay();
      return;
    }
    setStatus("Selected " + alignment.name + " in " + alignment.project + ".");
    if (userGraphic) {
      updateTrackMetrics(userGraphic.geometry);
    } else {
      resetComputedValues();
    }
  }

  function findAlignmentById(id) {
    return filteredAlignments.find(function(alignment) {
      return String(alignment.id) === String(id);
    }) || null;
  }

  function determineSide(line, segIdx, pt) {
    const path = line.paths[0];
    const i = Math.min(Math.max(segIdx, 0), path.length - 2);
    const a = path[i];
    const b = path[i + 1];
    return ((b[0] - a[0]) * (pt.y - a[1]) - (b[1] - a[1]) * (pt.x - a[0])) > 0 ? "left" : "right";
  }

  function findPerpendicularProjection(line, userPoint) {
    const path = line.paths[0];
    let bestMatch = null;

    for (let i = 0; i < path.length - 1; i += 1) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const segLenSq = (dx * dx) + (dy * dy);

      if (segLenSq === 0) {
        continue;
      }

      const px = userPoint.x - a[0];
      const py = userPoint.y - a[1];
      const t = ((px * dx) + (py * dy)) / segLenSq;

      if (t <= 0 || t >= 1) {
        continue;
      }

      const projX = a[0] + (t * dx);
      const projY = a[1] + (t * dy);
      const projectedPoint = new Point({
        x: projX,
        y: projY,
        spatialReference: line.spatialReference
      });
      const offsetLine = new Polyline({
        paths: [[[userPoint.x, userPoint.y], [projX, projY]]],
        spatialReference: line.spatialReference
      });
      const offsetM = geometryEngine.geodesicLength(offsetLine, "meters");

      if (!bestMatch || offsetM < bestMatch.offsetM) {
        bestMatch = {
          coordinate: projectedPoint,
          segIdx: i,
          t: t,
          offsetM: offsetM
        };
      }
    }

    return bestMatch;
  }

  function distanceAlongFromProjection(alignment, projResult) {
    const line = alignment.geometry;
    const path = line.paths[0];
    const segIdx = Math.min(Math.max(projResult.segIdx, 0), path.length - 2);
    const startVertex = path[segIdx];
    const nearPt = projResult.coordinate;
    const partialSeg = new Polyline({
      paths: [[startVertex.slice(0, 2), [nearPt.x, nearPt.y]]],
      spatialReference: line.spatialReference
    });
    const partialDist = geometryEngine.geodesicLength(partialSeg, "meters");
    return alignment.cumDists[segIdx] + partialDist;
  }

  function parseChainageInput(value) {
    const match = String(value || "").trim().match(/^([+-]?)(\d+)\s*\+\s*(\d{1,3})$/);
    if (!match) {
      return null;
    }

    const sign = match[1] === "-" ? -1 : 1;
    const km = Number(match[2]);
    const meters = Number(match[3]);
    if (!Number.isFinite(km) || !Number.isFinite(meters) || meters >= 1000) {
      return null;
    }

    return sign * ((km * 1000) + meters);
  }

  function resolvePointAtDistance(alignment, rawDistance) {
    const path = alignment.geometry.paths[0];
    const cumDists = alignment.cumDists;
    const totalLength = cumDists[cumDists.length - 1];

    if (rawDistance < 0 || rawDistance > totalLength) {
      return null;
    }

    if (rawDistance === 0) {
      return {
        coordinate: new Point({
          x: path[0][0],
          y: path[0][1],
          spatialReference: alignment.geometry.spatialReference
        }),
        segIdx: 0
      };
    }

    for (let i = 1; i < cumDists.length; i += 1) {
      if (rawDistance > cumDists[i]) {
        continue;
      }

      const segIdx = i - 1;
      const segStart = cumDists[segIdx];
      const segLength = cumDists[i] - segStart;
      const ratio = segLength === 0 ? 0 : (rawDistance - segStart) / segLength;
      const startVertex = path[segIdx];
      const endVertex = path[i];

      return {
        coordinate: new Point({
          x: startVertex[0] + ((endVertex[0] - startVertex[0]) * ratio),
          y: startVertex[1] + ((endVertex[1] - startVertex[1]) * ratio),
          spatialReference: alignment.geometry.spatialReference
        }),
        segIdx: Math.min(segIdx, path.length - 2)
      };
    }

    return {
      coordinate: new Point({
        x: path[path.length - 1][0],
        y: path[path.length - 1][1],
        spatialReference: alignment.geometry.spatialReference
      }),
      segIdx: Math.max(path.length - 2, 0)
    };
  }

  function ensureTargetGraphic(point) {
    if (!targetGraphic) {
      targetGraphic = new Graphic({ geometry: point, symbol: targetSym });
      trackingLayer.add(targetGraphic);
    } else {
      targetGraphic.geometry = point;
    }
  }

  function updateTrackMetrics(userPoint) {
    if (!selectedAlignment) {
      setStatus("Select an alignment first.");
      return;
    }

    const line = selectedAlignment.geometry;
    const result = findPerpendicularProjection(line, userPoint);
    if (!result || !result.coordinate) {
      showStationDisplay();
      resetComputedValues();
      clearTrackGraphics();
      setStatus("Alignment out of bounds.");
      return;
    }

    const nearPt = result.coordinate;
    const segIdx = Math.min(result.segIdx, line.paths[0].length - 2);
    const distanceAlong = distanceAlongFromProjection(selectedAlignment, result);
    const adjustedChainage = distanceAlong + selectedAlignment.startMeter;

    const offsetLine = new Polyline({
      paths: [[[userPoint.x, userPoint.y], [nearPt.x, nearPt.y]]],
      spatialReference: line.spatialReference
    });
    const offsetM = result.offsetM;
    const side = determineSide(line, segIdx, userPoint);

    const precision = lastAccuracy <= 3 ? 1 : 0;
    showStationDisplay();
    chainageValueEl.textContent = formatChainage(adjustedChainage, precision);
    offsetValueEl.textContent = offsetM.toFixed(1);
    offsetDirEl.innerHTML = 'm <span class="offset-direction ' + side + '">' + side.toUpperCase() + "</span>";
    setStatus("KM " + formatChainage(adjustedChainage, precision) + " | " + offsetM.toFixed(1) + " m " + side);

    if (!nearestGraphic) {
      nearestGraphic = new Graphic({ geometry: nearPt, symbol: nearestSym });
      trackingLayer.add(nearestGraphic);
    } else {
      nearestGraphic.geometry = nearPt;
    }

    if (!connectLineGraphic) {
      connectLineGraphic = new Graphic({ geometry: offsetLine, symbol: connectSym });
      trackingLayer.add(connectLineGraphic);
    } else {
      connectLineGraphic.geometry = offsetLine;
    }
  }

  function updateStakeoutGuidance(userPoint) {
    showStationDisplay();

    if (!selectedAlignment) {
      setStatus("Select an alignment first.");
      return;
    }

    if (!stakeoutTarget) {
      resetComputedValues();
      clearStakeoutGraphics();
      setStatus("Enter a target chainage or click on the map.");
      return;
    }

    const targetPoint = stakeoutTarget.coordinate;
    const guidanceLine = new Polyline({
      paths: [[[userPoint.x, userPoint.y], [targetPoint.x, targetPoint.y]]],
      spatialReference: selectedAlignment.geometry.spatialReference
    });
    const distanceToTarget = geometryEngine.geodesicLength(guidanceLine, "meters");
    const bearing = bearingToTarget(userPoint, targetPoint);

    const arrived = distanceToTarget < 2.0;
    if (arrived && !wasArrived && navigator.vibrate) {
      navigator.vibrate([100, 60, 100, 60, 300]);
    }
    wasArrived = arrived;
    const distCard = stationDisplayEl.querySelector(".metric-card:last-child");
    if (distCard) distCard.classList.toggle("arrived", arrived);

    ensureTargetGraphic(targetPoint);
    if (!stakeoutLineGraphic) {
      stakeoutLineGraphic = new Graphic({ geometry: guidanceLine, symbol: stakeoutLineSym });
      trackingLayer.add(stakeoutLineGraphic);
    } else {
      stakeoutLineGraphic.geometry = guidanceLine;
    }

    chainageValueEl.textContent = formatChainage(stakeoutTarget.displayMeters);
    offsetValueEl.textContent = distanceToTarget.toFixed(1);
    offsetDirEl.textContent = bearing;
    setStatus("Target " + formatChainage(stakeoutTarget.displayMeters) + " | " + distanceToTarget.toFixed(1) + " m | " + bearing);
  }

  function refreshModeDisplay() {
    setMetricMode(activeMode);
    btnTrackModeEl.classList.toggle("active", activeMode === "track");
    btnStakeoutModeEl.classList.toggle("active", activeMode === "stakeout");
    stakeoutRowEl.classList.toggle("hidden", activeMode !== "stakeout");

    if (!selectedAlignment) {
      resetComputedDisplay();
      return;
    }

    showStationDisplay();
    if (activeMode === "track") {
      clearStakeoutGraphics();
      if (userGraphic) {
        updateTrackMetrics(userGraphic.geometry);
      } else {
        resetComputedValues();
        setStatus("Track mode ready.");
      }
      return;
    }

    clearTrackGraphics();
    if (stakeoutTarget) {
      chainageValueEl.textContent = formatChainage(stakeoutTarget.displayMeters);
      if (userGraphic) {
        updateStakeoutGuidance(userGraphic.geometry);
      } else {
        ensureTargetGraphic(stakeoutTarget.coordinate);
        offsetValueEl.innerHTML = "&mdash;";
        offsetDirEl.textContent = "m";
        setStatus("Stakeout target set. Start GPS or double-click to guide to it.");
      }
      return;
    }

    resetComputedValues();
    setStatus("Enter a target chainage or click on the map.");
  }

  function updateFromUserPoint(userPoint) {
    if (activeMode === "stakeout") {
      updateStakeoutGuidance(userPoint);
    } else {
      updateTrackMetrics(userPoint);
    }
  }

  window.setAppMode = function(mode) {
    activeMode = mode === "stakeout" ? "stakeout" : "track";
    refreshModeDisplay();
  };

  window.applyStakeoutTarget = function() {
    if (!selectedAlignment) {
      setStatus("Select an alignment first.");
      return;
    }

    const displayMeters = parseChainageInput(stakeoutInputEl.value);
    if (displayMeters === null) {
      clearStakeoutTarget(false);
      showStationDisplay();
      resetComputedValues();
      setStatus("Enter a valid chainage like 1+250.");
      return;
    }

    const rawDistance = displayMeters - selectedAlignment.startMeter;
    const totalLength = selectedAlignment.cumDists[selectedAlignment.cumDists.length - 1];
    if (rawDistance < 0 || rawDistance > totalLength) {
      clearStakeoutTarget(false);
      showStationDisplay();
      resetComputedValues();
      setStatus("Target chainage is outside this alignment.");
      return;
    }

    const resolvedPoint = resolvePointAtDistance(selectedAlignment, rawDistance);
    if (!resolvedPoint) {
      clearStakeoutTarget(false);
      showStationDisplay();
      resetComputedValues();
      setStatus("Unable to resolve that target chainage.");
      return;
    }

    stakeoutTarget = {
      displayMeters: displayMeters,
      rawDistance: rawDistance,
      coordinate: resolvedPoint.coordinate,
      segIdx: resolvedPoint.segIdx
    };

    showStationDisplay();
    ensureTargetGraphic(stakeoutTarget.coordinate);
    chainageValueEl.textContent = formatChainage(stakeoutTarget.displayMeters);
    offsetValueEl.innerHTML = "&mdash;";
    offsetDirEl.textContent = "m";

    if (userGraphic) {
      updateStakeoutGuidance(userGraphic.geometry);
    } else {
      setStatus("Stakeout target set. Start GPS or double-click to guide to it.");
    }
  };

  async function loadPublicLayer() {
    setStatus("Loading alignments...");

    try {
      const layer = new FeatureLayer({ url: PUBLIC_LAYER_URL });
      await layer.load();
      const features = await queryAllFeatures(layer);

      allAlignments = features.map(function(feature, index) {
        return createAlignmentModel(feature, index);
      }).filter(Boolean);

      log("Layer loaded: " + layer.title);
      log("Alignments loaded: " + allAlignments.length);

      populateProjectOptions();
      filteredAlignments = allAlignments.slice();
      renderFilteredAlignments();
      zoomToAlignments(filteredAlignments);
      setStatus("Choose a project, then select an alignment.");
    } catch (err) {
      log("ERROR: " + err.message);
      setStatus("Failed to load public alignment layer.");
      projectSelect.innerHTML = '<option value="">Load failed</option>';
      alignmentSelect.innerHTML = '<option value="">Unavailable</option>';
      alignmentSelect.disabled = true;
    }
  }

  function startGps() {
    if (gpsWatchId !== null) return;

    if (!navigator.geolocation) {
      gpsIndicatorEl.className = "gps-indicator error";
      return;
    }

    gpsIndicatorEl.className = "gps-indicator";

    gpsWatchId = navigator.geolocation.watchPosition(
      function(pos) {
        const pt = new Point({
          longitude: pos.coords.longitude,
          latitude: pos.coords.latitude,
          spatialReference: { wkid: 4326 }
        });
        const mapPt = projectionReady ? projection.project(pt, view.spatialReference) : pt;

        updateAccuracyDisplay(pos.coords.accuracy);
        lastRawMapPt = mapPt;
        document.getElementById("btnRecenter").style.display = "";

        const accuracyCircle = geometryEngine.geodesicBuffer(mapPt, pos.coords.accuracy, "meters");
        if (!accuracyGraphic) {
          accuracyGraphic = new Graphic({ geometry: accuracyCircle, symbol: accuracySym });
          trackingLayer.add(accuracyGraphic);
        } else {
          accuracyGraphic.geometry = accuracyCircle;
        }

        if (!smoothedPoint) {
          smoothedPoint = mapPt;
        } else {
          smoothedPoint = new Point({
            x: GPS_ALPHA * mapPt.x + (1 - GPS_ALPHA) * smoothedPoint.x,
            y: GPS_ALPHA * mapPt.y + (1 - GPS_ALPHA) * smoothedPoint.y,
            spatialReference: mapPt.spatialReference
          });
        }

        if (!userGraphic) {
          userGraphic = new Graphic({ geometry: mapPt, symbol: userSym });
          trackingLayer.add(userGraphic);
        } else {
          userGraphic.geometry = mapPt;
        }

        updateFromUserPoint(smoothedPoint);
      },
      function(err) {
        gpsIndicatorEl.className = "gps-indicator error";
        setStatus("GPS: " + err.message);
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );
  };

  window.toggleBasemap = function() {
    applyBasemapMode(currentBasemapMode === "map" ? "satellite" : "map");
  };

  window.recenterMap = function() {
    if (!lastRawMapPt) return;
    view.goTo({ target: lastRawMapPt, zoom: Math.max(view.zoom, 15) }, { animate: true, duration: 500 }).catch(function() {
      return null;
    });
  };

  // --- Symbols ---
  const accuracySym = new SimpleFillSymbol({
    color: [74, 222, 128, 0.08],
    outline: { color: [74, 222, 128, 0.35], width: 1 }
  });
  const alignmentSym = new SimpleLineSymbol({ color: [255, 237, 0, 0.6], width: 3 });
  const selectedSym = new SimpleLineSymbol({ color: [255, 237, 0, 1], width: 5 });
  const userSym = new SimpleMarkerSymbol({
    color: [74, 222, 128, 1],
    size: 14,
    outline: { color: [255, 255, 255, 0.9], width: 2 }
  });
  const nearestSym = new SimpleMarkerSymbol({
    color: [255, 237, 0, 1],
    size: 10,
    style: "diamond",
    outline: { color: [10, 25, 41, 0.8], width: 1.5 }
  });
  const connectSym = new SimpleLineSymbol({ color: [255, 255, 255, 0.4], width: 1.5, style: "dash" });
  const targetSym = new SimpleMarkerSymbol({
    color: [56, 189, 248, 1],
    size: 14,
    style: "x",
    outline: { color: [255, 255, 255, 0.9], width: 2 }
  });
  const stakeoutLineSym = new SimpleLineSymbol({ color: [56, 189, 248, 0.75], width: 2.5 });

  // --- Layers & Map ---
  const alignmentLayer = new GraphicsLayer();
  const trackingLayer = new GraphicsLayer();

  const map = new Map({
    basemap: basemapModes[currentBasemapMode],
    layers: [alignmentLayer, trackingLayer]
  });

  const view = new MapView({
    container: "viewDiv",
    map: map,
    center: [26.0, 44.5],
    zoom: 7,
    ui: { components: ["zoom"] },
    constraints: { rotationEnabled: true }
  });

  view.ui.move("zoom", "bottom-right");

  projection.load()
    .then(function() {
      projectionReady = true;
      log("Projection ready");
    })
    .catch(function(err) {
      log("Projection load failed: " + err.message);
    });

  applyBasemapMode(currentBasemapMode);
  setMetricMode(activeMode);

  // --- Event Listeners ---
  projectSelect.addEventListener("change", function(event) {
    applyProjectFilter(event.target.value);
  });

  alignmentSelect.addEventListener("change", function(event) {
    const alignment = findAlignmentById(event.target.value);
    if (!alignment) {
      clearSelection("Select an alignment.");
      return;
    }
    selectAlignment(alignment);
  });

  stakeoutInputEl.addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      applyStakeoutTarget();
    }
  });

  view.on("click", function(event) {
    // In stakeout mode with an alignment selected, click on map to project & set target
    if (activeMode === "stakeout" && selectedAlignment) {
      const clickPt = event.mapPoint;
      const proj = findPerpendicularProjection(selectedAlignment.geometry, clickPt);
      if (proj) {
        const distAlong = distanceAlongFromProjection(selectedAlignment, proj);
        const displayMeters = distAlong + selectedAlignment.startMeter;
        stakeoutInputEl.value = formatChainage(displayMeters);
        applyStakeoutTarget();
      } else {
        setStatus("Click closer to the alignment to set a target.");
      }
      return;
    }

    if (!projectSelect.value) {
      setStatus("Choose a project first.");
      return;
    }

    view.hitTest(event).then(function(result) {
      const hit = result.results.find(function(entry) {
        return entry.graphic && entry.graphic.layer === alignmentLayer;
      });

      if (!hit) {
        return;
      }

      const alignment = findAlignmentById(hit.graphic.attributes._alignmentId);
      if (alignment) {
        selectAlignment(alignment);
      }
    });
  });

  view.on("double-click", function(event) {
    event.stopPropagation();

    if (!selectedAlignment) {
      setStatus("Select an alignment before simulating a position.");
      return;
    }

    const pt = event.mapPoint;
    if (!userGraphic) {
      userGraphic = new Graphic({ geometry: pt, symbol: userSym });
      trackingLayer.add(userGraphic);
    } else {
      userGraphic.geometry = pt;
    }
    updateFromUserPoint(pt);
  });

  async function requestWakeLock() {
    if (!navigator.wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
  }

  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "visible") requestWakeLock();
  });

  view.when(function() {
    loadPublicLayer();
    startGps();
    requestWakeLock();
  });
});
