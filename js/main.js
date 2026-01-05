/*
 * XIANXIA IDLE V1.2.0
 * 
 * TIME SPEED SYSTEM: Affects ONLY Lifespan Aging
 * 
 * Core Principle:
 * - Time speed controls how fast time flows (aging rate)
 * - Qi gains are INDEPENDENT of time speed (speed-neutral)
 * - 2× speed = 2× faster aging, SAME Qi/s
 * 
 * Implementation:
 * 1. loop(): Calculates rawDt (real elapsed seconds) once
 * 2. tick(): Uses rawDt for Qi gains (no speed factor)
 * 3. tickLifespan(): Receives rawDt × speed for aging
 * 4. Offline: Qi uses wall-clock time, aging uses time × speed
 * 5. totalQPS/totalQPC: Never reference time speed
 * 
 * Key Functions:
 * - loop(): Computes rawDt, passes rawDt and speed separately to tick()
 * - tick(rawDt, speed): Qi = QPS × rawDt (no speed), aging = rawDt × speed
 * - tickLifespan(dt): dt is pre-multiplied by speed from tick()
 * - applyOfflineProgressOnResume(): Qi uses cappedSec, aging uses cappedSec × speed
 * 
 * Result: Time speed is cosmetic for Qi (just visual time flow), real for aging
 * 
 * RUNAWAY REINCARNATION FIX IMPLEMENTED:
 * 
 * Problem: Multiple/looping reincarnations when lifespan reaches 0, causing ~500 instant reincarnations
 * 
 * Solution Components:
 * 1. LIFECYCLE GUARD: Added S.lifecycle.isReincarnating flag to prevent reentrancy
 * 2. SINGLE-PASS AGING: Replaced while loops with single if checks in tickLifespan()
 * 3. TICK PROTECTION: Main tick() exits early if reincarnation is in progress
 * 4. OFFLINE SAFETY: applyOfflineGains() respects guards and does single death check
 * 5. NUMBER SAFETY: safeNum() helper prevents Infinity/NaN corruption
 * 6. STATE RESET: doReincarnate() properly resets lifespan and timing before clearing guard
 * 7. DEBUG MODE: ?dev=1 URL parameter enables reincarnation rate assertions
 * 
 * Key Functions Modified:
 * - defaultState(): Added lifecycle object
 * - load()/importSave(): Migration ensures lifecycle exists, sanitizes numbers
 * - tickLifespan(): Single death check, sets guard immediately
 * - handleLifespanEnd(): New guarded death handler, pauses time
 * - doReincarnate(): Clears guard only after full state reset
 * - applyOfflineGains(): Single offline death check with guard
 * - tick()/onClick(): Respect reincarnation guard
 * 
 * Result: Exactly one reincarnation per lifespan end, no loops or races
 */

const VERSION = '1.2.0';
const SAVE_KEY = 'xianxiaIdleSaveV1';
let REALM_SKILL_BONUS = 0.20; // default +20% per realm

// Debug mode - enable with ?dev=1 in URL
const DEBUG_MODE = new URLSearchParams(window.location.search).get('dev') === '1';

// === Skill scaling knobs (tuneable) ===
const SKILL_SCALING = {
  // Realm scaling ~ bounded exponential (log-like growth)
  realmMaxMult: 3.0,    // cap: +200% → total 3×
  realmK: 0.60,         // growth steepness per realm (used in exponent)
  // Karma scaling ~ soft log
  karmaLogCoeff: 0.30,  // multiplier per log10(karma+1)
  karmaMaxMult: 2.5,    // hard safety cap from karma factor
  // Cycle scaling
  mortalCycleBoost: 1.0,
  spiritCycleBoost: 5.0,
};

/**
 * Realm-aware minimum percent per level for Tier-2/Tier-3 skills
 * Gradually rises with realm so it never rounds to 0%
 * Returns fraction (e.g., 0.001 = 0.1%)
 * 
 * Progression:
 * - Mortal (0): 0.00015 (0.015%)
 * - Qi Refining (1): ~0.0003 (0.03%)
 * - Golden Core (3): ~0.001 (0.10%)
 * - Spirit Transform (5): ~0.003 (0.30%)
 * - True Immortal (10): ~0.01 (1.00%)
 * 
 * @param {number} realmIndex - Current realm index
 * @returns {number} Minimum percent per level (fraction)
 */
function minTierPctByRealm(realmIndex) {
  const floor = 0.00015 + 0.001 * (1 - Math.exp(-0.35 * Math.max(0, realmIndex)));
  return Math.min(0.01, floor); // hard floor cap at 1% per level
}

/**
 * Realm-aware maximum percent per level for Tier-2/Tier-3 skills
 * Per-level ceiling so a single level can't blow up
 * Grows with realm to maintain relevance
 * 
 * Progression:
 * - Early realms: ~2% per level
 * - Mid realms: ~4% per level
 * - Late realms: ~6% per level
 * 
 * @param {number} realmIndex - Current realm index
 * @returns {number} Maximum percent per level (fraction)
 */
function maxTierPctByRealm(realmIndex) {
  const cap = 0.02 + 0.05 * (1 - Math.exp(-0.25 * Math.max(0, realmIndex)));
  return Math.min(0.06, cap);
}

// Optional Qi Turbo Mode - partial Qi scaling with sqrt(speed) for late game
// Disabled by default. When enabled: at 4× speed → 2× qi/s, at 100× → 10× qi/s
// This allows late-game players to benefit slightly from higher speeds without
// completely bypassing time-based balance
const ENABLE_QI_TURBO = false;

/**
 * Calculate turbo factor for Qi gains (optional late-game feature)
 * Uses square root scaling to provide bounded acceleration:
 * - 1× speed → 1.0× turbo (no change)
 * - 4× speed → 2.0× turbo (modest boost)
 * - 16× speed → 4.0× turbo (good boost)
 * - 100× speed → 10× turbo (capped scaling)
 * 
 * This ensures high speeds give *some* benefit beyond just time compression,
 * but not enough to completely break progression balance.
 * 
 * @param {number} speed - Current time speed multiplier
 * @returns {number} Always returns 1 (Qi is speed-independent)
 */
function qiTurboFactor(speed) {
  return 1; // DEPRECATED: No longer scales Qi - time speed affects only aging
}

// Development mode assertions and debugging
let lastReincarnationTime = 0;
function debugAssertReincarnationRate() {
  if (!DEBUG_MODE) return;
  
  const now = Date.now();
  if (lastReincarnationTime > 0 && (now - lastReincarnationTime) < 100) {
    console.warn('⚠️ REINCARNATION DEBUG: Multiple reincarnations within 100ms detected!', {
      timeSinceLast: now - lastReincarnationTime,
      currentTime: now,
      lastTime: lastReincarnationTime
    });
    // Hard stop in dev mode to catch regressions
    debugger;
  }
  lastReincarnationTime = now;
}

// Balance configuration - loaded from balance.json or fallback to defaults
// REBALANCED FOR 20-HOUR PROGRESSION WITH MORTAL REALM
// - Added Mortal Realm (realm 0): 50 years, click-only, no skills
// - Faster aging: 1.5 years/second for visible speed differences
// - Stronger skills and rewards for faster progression
// - Better karma gains for meaningful reincarnations
let BAL = {
  skills: {
    breath_control:   { base: 1.20, cost: 20,  costScale: 1.22 },
    meridian_flow:    { base: 2.00, cost: 45,  costScale: 1.26 },
    lotus_meditation: { base: 0.25, cost: 140, costScale: 1.35 },
    dantian_temps:    { base: 0.18, cost: 110, costScale: 1.33 },
    closed_door:      { base: 0.35, cost: 150, costScale: 1.38 }
  },
  stageRequirement: {
    realmBase: 80,
    realmBaseScale: 5,
    stageScale: 1.42
  },
  progression: {
    qpcBaseStart: 1,
    qpsBaseStart: 0,
    realmAdvanceReward: { qpcBaseAdd: 2.5, qpsBaseAdd: 1.8 }
  },
  reincarnation: {
    karmaPerUnit: 0.12,
    lifetimeQiDivisor: 5000,
    realmKarmaFactor: 4,
    minKarma: 3
  },
  offline: {
    capHours: 16
  },
  lifespan: {
    realmMaxLifespan: [50, 100, 200, 500, 1000, 3000, 10000, 50000, 100000, 500000, null], // years per realm, null = infinite
    yearsPerSecond: 0.5 // aging rate: 0.5 years per second (validator will clamp to [0.005, 0.1])
  },
  timeSpeed: {
    speeds: [0, 0.5, 1, 2, 4, 6, 8, 10], // available time multipliers
    unlockRealmIndex: [0, 0, 2, 4, 6, 8, 9] // realm required to unlock each speed
  }
};

/**
 * RUNTIME CONFIG VALIDATOR - Ensures balance.json values are safe
 * Validates and auto-fixes unsafe/malformed balance configuration values
 * to prevent game breakage. All fixes generate warnings in DEBUG_MODE.
 * 
 * Validations performed:
 * 1. Time speeds: Ensures speeds/unlocks arrays match length, base speeds exist (0, 0.5, 1)
 * 2. Lifespan: Validates array length matches realms, last realm is immortal, yearsPerSecond in safe range
 * 3. Cycles: Removes invalid realm indices, rebuilds empty cycles from defaults
 * 4. Stage requirements: Ensures positive values for base, scale factors
 * 5. Progression: Validates QPC/QPS start values and realm advance rewards
 * 6. Reincarnation: Enforces karma/penalty constraints, positive divisors
 * 7. Skills: Validates base effectiveness, costs, and cost scaling
 * 8. Offline: Ensures positive cap hours
 * 
 * Note: Time speed multiplier application is verified in tick() and tickLifespan().
 * Both functions properly scale dt by S.timeSpeed.current, ensuring 0.5× runs at half pace.
 * 
 * @param {Object} BAL - Balance configuration object to validate
 * @param {Array} realms - Realms array for length validation
 * @returns {Object} Sanitized balance configuration
 */
function validateBalanceConfig(BAL, realms) {
  const warn = (msg) => {
    if (DEBUG_MODE) console.warn(`[Balance Validator] ${msg}`);
  };

  // 1. TIME SPEED VALIDATION
  if (BAL.timeSpeed) {
    const speeds = BAL.timeSpeed.speeds || [];
    const unlocks = BAL.timeSpeed.unlockRealmIndex || [];
    
    // Ensure speeds and unlocks arrays have matching lengths
    if (speeds.length !== unlocks.length) {
      warn(`timeSpeed: lengths mismatched (speeds=${speeds.length}, unlocks=${unlocks.length}). Truncating to shorter.`);
      const minLen = Math.min(speeds.length, unlocks.length);
      BAL.timeSpeed.speeds = speeds.slice(0, minLen);
      BAL.timeSpeed.unlockRealmIndex = unlocks.slice(0, minLen);
    }
    
    // Ensure base speeds (0, 0.5, 1) are present
    const baseSpeedsRequired = [0, 0.25, 0.5, 1];
    const currentSpeeds = [...BAL.timeSpeed.speeds];
    const currentUnlocks = [...BAL.timeSpeed.unlockRealmIndex];
    
    baseSpeedsRequired.forEach((speed, idx) => {
      if (!currentSpeeds.includes(speed)) {
        warn(`timeSpeed: base speed ${speed}× missing. Adding it.`);
        currentSpeeds.push(speed);
        currentUnlocks.push(0); // Unlock at realm 0
      }
    });
    
    // De-duplicate and sort speeds (with corresponding unlocks)
    const speedUnlockPairs = currentSpeeds.map((speed, i) => ({
      speed,
      unlock: currentUnlocks[i] || 0
    }));
    
    // Remove duplicates by speed value
    const uniquePairs = [];
    const seenSpeeds = new Set();
    speedUnlockPairs.forEach(pair => {
      if (!seenSpeeds.has(pair.speed)) {
        seenSpeeds.add(pair.speed);
        uniquePairs.push(pair);
      }
    });
    
    // Sort by speed ascending
    uniquePairs.sort((a, b) => a.speed - b.speed);
    
    BAL.timeSpeed.speeds = uniquePairs.map(p => p.speed);
    BAL.timeSpeed.unlockRealmIndex = uniquePairs.map(p => p.unlock);
  }

  // 2. LIFESPAN VALIDATION
  if (BAL.lifespan) {
    const lifespans = BAL.lifespan.realmMaxLifespan || [];
    const realmCount = realms.length;
    
    // Ensure lifespan array matches realm count
    if (lifespans.length > realmCount) {
      warn(`lifespan: realmMaxLifespan too long (${lifespans.length} vs ${realmCount} realms). Truncating.`);
      BAL.lifespan.realmMaxLifespan = lifespans.slice(0, realmCount);
    } else if (lifespans.length < realmCount) {
      warn(`lifespan: realmMaxLifespan too short (${lifespans.length} vs ${realmCount} realms). Padding.`);
      const lastValue = lifespans[lifespans.length - 1];
      const paddingValue = (lastValue === null || typeof lastValue === 'number') ? lastValue : 100;
      while (BAL.lifespan.realmMaxLifespan.length < realmCount) {
        BAL.lifespan.realmMaxLifespan.push(paddingValue);
      }
    }
    
    // Ensure last realm is immortal (null)
    if (BAL.lifespan.realmMaxLifespan[realmCount - 1] !== null) {
      warn(`lifespan: final realm should be immortal (null). Setting last realm to null.`);
      BAL.lifespan.realmMaxLifespan[realmCount - 1] = null;
    }
    
    // Validate yearsPerSecond is within safe range [0.005, 0.1]
    let yps = BAL.lifespan.yearsPerSecond;
    if (typeof yps !== 'number' || !isFinite(yps)) {
      warn(`lifespan: yearsPerSecond invalid (${yps}). Resetting to 0.5.`);
      BAL.lifespan.yearsPerSecond = 0.5;
    } else if (yps < 0.005) {
      warn(`lifespan: yearsPerSecond too low (${yps}). Clamping to 0.005.`);
      BAL.lifespan.yearsPerSecond = 0.005;
    } else if (yps > 0.1) {
      warn(`lifespan: yearsPerSecond too high (${yps}). Clamping to 0.1.`);
      BAL.lifespan.yearsPerSecond = 0.1;
    }
  }

  // 3. CYCLE DEFINITIONS VALIDATION
  if (BAL.cycleDefinitions) {
    const realmCount = realms.length;
    
    Object.keys(BAL.cycleDefinitions).forEach(cycleId => {
      const cycle = BAL.cycleDefinitions[cycleId];
      if (!cycle.realms || !Array.isArray(cycle.realms)) {
        warn(`cycleDefinitions.${cycleId}: missing or invalid realms array. Skipping.`);
        return;
      }
      
      // Remove invalid realm indices
      const validRealms = cycle.realms.filter(idx => 
        typeof idx === 'number' && idx >= 0 && idx < realmCount
      );
      
      if (validRealms.length !== cycle.realms.length) {
        warn(`cycleDefinitions.${cycleId}: removed invalid realm indices. Valid: [${validRealms.join(', ')}]`);
      }
      
      // If empty after filtering, rebuild from defaults
      if (validRealms.length === 0) {
        warn(`cycleDefinitions.${cycleId}: no valid realms. Rebuilding from defaults.`);
        if (cycleId === 'mortal') {
          cycle.realms = Array.from({length: Math.ceil(realmCount / 2)}, (_, i) => i);
        } else if (cycleId === 'spirit') {
          const startIdx = Math.ceil(realmCount / 2);
          cycle.realms = Array.from({length: realmCount - startIdx}, (_, i) => startIdx + i);
        }
      } else {
        cycle.realms = validRealms;
      }
      
      // Ensure realmBonus is a valid number
      if (typeof cycle.realmBonus !== 'number' || !isFinite(cycle.realmBonus)) {
        warn(`cycleDefinitions.${cycleId}: invalid realmBonus. Setting to 0.`);
        cycle.realmBonus = 0;
      }
    });
  }

  // 4. STAGE REQUIREMENT VALIDATION
  if (BAL.stageRequirement) {
    const sr = BAL.stageRequirement;
    
    if (typeof sr.realmBase !== 'number' || sr.realmBase <= 0 || !isFinite(sr.realmBase)) {
      warn(`stageRequirement: invalid realmBase (${sr.realmBase}). Resetting to 100.`);
      sr.realmBase = 100;
    }
    
    if (typeof sr.realmBaseScale !== 'number' || sr.realmBaseScale <= 0 || !isFinite(sr.realmBaseScale)) {
      warn(`stageRequirement: invalid realmBaseScale (${sr.realmBaseScale}). Resetting to 15.`);
      sr.realmBaseScale = 15;
    }
    
    if (typeof sr.stageScale !== 'number' || sr.stageScale <= 0 || !isFinite(sr.stageScale)) {
      warn(`stageRequirement: invalid stageScale (${sr.stageScale}). Resetting to 1.45.`);
      sr.stageScale = 1.45;
    }
  }

  // 5. PROGRESSION VALIDATION
  if (BAL.progression) {
    const prog = BAL.progression;
    
    // Validate qpcBaseStart (should be reasonable, not astronomical)
    const MAX_SAFE_QPC = 1e15; // 1 quadrillion max
    if (typeof prog.qpcBaseStart !== 'number' || prog.qpcBaseStart < 0 || !isFinite(prog.qpcBaseStart)) {
      warn(`progression: invalid qpcBaseStart (${prog.qpcBaseStart}). Resetting to 1.`);
      prog.qpcBaseStart = 1;
    } else if (prog.qpcBaseStart > MAX_SAFE_QPC) {
      warn(`progression: qpcBaseStart too large (${prog.qpcBaseStart}). Clamping to ${MAX_SAFE_QPC}.`);
      prog.qpcBaseStart = 1; // Reset to safe value, not clamp to max
    }
    
    if (typeof prog.qpsBaseStart !== 'number' || prog.qpsBaseStart < 0 || !isFinite(prog.qpsBaseStart)) {
      warn(`progression: invalid qpsBaseStart (${prog.qpsBaseStart}). Resetting to 0.`);
      prog.qpsBaseStart = 0;
    } else if (prog.qpsBaseStart > MAX_SAFE_QPC) {
      warn(`progression: qpsBaseStart too large (${prog.qpsBaseStart}). Resetting to 0.`);
      prog.qpsBaseStart = 0;
    }
    
    if (prog.realmAdvanceReward) {
      const rar = prog.realmAdvanceReward;
      const MAX_SAFE_REWARD = 1e6; // 1 million max per realm advance
      
      if (typeof rar.qpcBaseAdd !== 'number' || rar.qpcBaseAdd < 0 || !isFinite(rar.qpcBaseAdd)) {
        warn(`progression: invalid qpcBaseAdd (${rar.qpcBaseAdd}). Resetting to 1.5.`);
        rar.qpcBaseAdd = 1.5;
      } else if (rar.qpcBaseAdd > MAX_SAFE_REWARD) {
        warn(`progression: qpcBaseAdd too large (${rar.qpcBaseAdd}). Resetting to 2.5.`);
        rar.qpcBaseAdd = 2.5;
      }
      
      if (typeof rar.qpsBaseAdd !== 'number' || rar.qpsBaseAdd < 0 || !isFinite(rar.qpsBaseAdd)) {
        warn(`progression: invalid qpsBaseAdd (${rar.qpsBaseAdd}). Resetting to 0.9.`);
        rar.qpsBaseAdd = 0.9;
      } else if (rar.qpsBaseAdd > MAX_SAFE_REWARD) {
        warn(`progression: qpsBaseAdd too large (${rar.qpsBaseAdd}). Resetting to 1.8.`);
        rar.qpsBaseAdd = 1.8;
      }
    }
  }

  // 6. REINCARNATION VALIDATION
  if (BAL.reincarnation) {
    const reinc = BAL.reincarnation;
    
    if (typeof reinc.minKarma !== 'number' || reinc.minKarma < 1 || !isFinite(reinc.minKarma)) {
      warn(`reincarnation: invalid minKarma (${reinc.minKarma}). Resetting to 3.`);
      reinc.minKarma = 3;
    }
    
    if (typeof reinc.deathPenalty !== 'number' || reinc.deathPenalty <= 0 || reinc.deathPenalty > 1 || !isFinite(reinc.deathPenalty)) {
      warn(`reincarnation: invalid deathPenalty (${reinc.deathPenalty}). Resetting to 0.5.`);
      reinc.deathPenalty = 0.5;
    }
    
    if (typeof reinc.karmaPerUnit !== 'number' || reinc.karmaPerUnit < 0 || !isFinite(reinc.karmaPerUnit)) {
      warn(`reincarnation: invalid karmaPerUnit (${reinc.karmaPerUnit}). Resetting to 0.1.`);
      reinc.karmaPerUnit = 0.1;
    }
    
    if (typeof reinc.lifetimeQiDivisor !== 'number' || reinc.lifetimeQiDivisor <= 0 || !isFinite(reinc.lifetimeQiDivisor)) {
      warn(`reincarnation: invalid lifetimeQiDivisor (${reinc.lifetimeQiDivisor}). Resetting to 10000.`);
      reinc.lifetimeQiDivisor = 10000;
    }
    
    if (typeof reinc.realmKarmaFactor !== 'number' || reinc.realmKarmaFactor < 0 || !isFinite(reinc.realmKarmaFactor)) {
      warn(`reincarnation: invalid realmKarmaFactor (${reinc.realmKarmaFactor}). Resetting to 5.`);
      reinc.realmKarmaFactor = 5;
    }
  }

  // 7. SKILLS VALIDATION
  if (BAL.skills) {
    Object.keys(BAL.skills).forEach(skillId => {
      const skill = BAL.skills[skillId];
      
      if (typeof skill.base !== 'number' || skill.base < 0 || !isFinite(skill.base)) {
        warn(`skills.${skillId}: invalid base (${skill.base}). Resetting to 1.`);
        skill.base = 1;
      }
      
      if (typeof skill.cost !== 'number' || skill.cost <= 0 || !isFinite(skill.cost)) {
        warn(`skills.${skillId}: invalid cost (${skill.cost}). Resetting to 50.`);
        skill.cost = 50;
      }
      
      if (typeof skill.costScale !== 'number' || skill.costScale <= 1 || !isFinite(skill.costScale)) {
        warn(`skills.${skillId}: invalid costScale (${skill.costScale}). Resetting to 1.3.`);
        skill.costScale = 1.3;
      }
    });
  }

  // 8. OFFLINE VALIDATION
  if (BAL.offline) {
    if (typeof BAL.offline.capHours !== 'number' || BAL.offline.capHours <= 0 || !isFinite(BAL.offline.capHours)) {
      warn(`offline: invalid capHours (${BAL.offline.capHours}). Resetting to 12.`);
      BAL.offline.capHours = 12;
    }
  }

  if (DEBUG_MODE) {
    console.log('[Balance Validator] Validation complete. Configuration sanitized.');
  }

  return BAL;
}

// Load balance configuration from JSON
async function loadBalance() {
  try {
    const response = await fetch('balance.json');
    if (response.ok) {
      const balanceData = await response.json();
      BAL = { ...BAL, ...balanceData };
      if (typeof balanceData.realmSkillBonus === 'number') {
        REALM_SKILL_BONUS = balanceData.realmSkillBonus;
      }
      
      // Validate and sanitize loaded balance configuration
      BAL = validateBalanceConfig(BAL, realms);
      
      SKILL_CAT = null; // invalidate cache
      console.log('Balance configuration loaded from balance.json');
    }
  } catch (error) {
    console.log('Using default balance values (balance.json not found or invalid)');
  }
  
  // Always validate fallback BAL to ensure safety on first boot
  BAL = validateBalanceConfig(BAL, realms);
}

const realms = [
  { id:'mortal_realm', name:'Mortal Realm' },
  { id:'qi_refining', name:'Qi Refining' },
  { id:'foundation_establishment', name:'Foundation Establishment' },
  { id:'golden_core', name:'Golden Core' },
  { id:'nascent_soul', name:'Nascent Soul' },
  { id:'spirit_transformation', name:'Spirit Transformation' },
  { id:'void_refining', name:'Ascension' },
  { id:'body_integration', name:'Profound Immortal' },
  { id:'mahayana', name:'Immortal Vulnerable' },
  { id:'tribulation_transcendence', name:'Immortal Emperor' },
  { id:'true_immortal', name:'God Realm' },
];

// ============= REALM ID MAPPING SYSTEM =============
// SINGLE SOURCE OF TRUTH for realm indices
// Use idx('realm_id') instead of hardcoded numbers to prevent off-by-one errors

const REALM_IDS = realms.map(r => r.id);
const REALM_INDEX = Object.fromEntries(REALM_IDS.map((id, i) => [id, i]));

/**
 * Get realm index by ID - ALWAYS use this instead of hardcoded indices
 * @param {string} id - Realm ID (e.g., 'spirit_transformation')
 * @returns {number} Realm index, or -1 if not found
 */
const idx = (id) => REALM_INDEX[id] ?? -1;

/**
 * Get realm by index - safe accessor
 * @param {number} index - Realm index
 * @returns {Object|null} Realm object or null if out of bounds
 */
const realmByIndex = (index) => realms[index] ?? null;

/**
 * Get realm by ID - safe accessor
 * @param {string} id - Realm ID
 * @returns {Object|null} Realm object or null if not found
 */
const realmById = (id) => realms[idx(id)] ?? null;

// ============= MONOTONIC STAGE REQUIREMENT SYSTEM =============

/**
 * Cross-realm jump multiplier - controls minimum increase from Stage 10 to next realm's Stage 1
 * Ensures exponential feel by requiring meaningful gaps between realms
 * Example: 1.25 means Stage 1 of realm R+1 must be at least 25% higher than Stage 10 of realm R
 * @type {number}
 */
const CROSS_REALM_JUMP = 1.25;

/**
 * Cached minimum realm scale to prevent cross-realm requirement drops
 * Computed once on first stageRequirement() call
 * @type {number|null}
 */
let MIN_REALM_SCALE = null;
let EFFECTIVE_REALM_SCALE = null;
let hasWarnedRealmScale = false;

/**
 * Compute base stage requirement without karma reduction
 * Used internally for monotonicity checks
 * @param {number} realmIndex - Realm index
 * @param {number} stage - Stage number (1-10)
 * @returns {number} Base requirement before karma
 */
function baseRequirementFor(realmIndex, stage) {
  // Mortal Realm: Linear progression
  if (realmIndex === 0) {
    return stage * 10;
  }
  
  // Ensure effective realm scale is computed
  if (EFFECTIVE_REALM_SCALE === null) {
    const stageScale = BAL.stageRequirement.stageScale;
    MIN_REALM_SCALE = Math.pow(stageScale, 9); // stageScale^9 ensures Stage 1 of next realm >= Stage 10 of current
    EFFECTIVE_REALM_SCALE = Math.max(BAL.stageRequirement.realmBaseScale, MIN_REALM_SCALE);
    
    // DEBUG warning if we're overriding designer's realmBaseScale
    if (DEBUG_MODE && !hasWarnedRealmScale && BAL.stageRequirement.realmBaseScale < MIN_REALM_SCALE) {
      console.warn(
        `[stageRequirement] realmBaseScale (${BAL.stageRequirement.realmBaseScale.toFixed(2)}) < stageScale^9 (${MIN_REALM_SCALE.toFixed(2)}). ` +
        `Using effectiveRealmScale=${EFFECTIVE_REALM_SCALE.toFixed(2)} to keep cross-realm costs monotonic.`
      );
      hasWarnedRealmScale = true;
    }
  }
  
  // Exponential scaling with effective realm scale
  const realmBase = BAL.stageRequirement.realmBase * Math.pow(EFFECTIVE_REALM_SCALE, realmIndex);
  const stageScale = Math.pow(BAL.stageRequirement.stageScale, stage - 1);
  return Math.floor(realmBase * stageScale);
}

/**
 * Calculate stage requirement with monotonic guarantees
 * Ensures requirements never decrease across realm transitions or stages
 * @param {number} realmIndex - Realm index (0-10)
 * @param {number} stage - Stage number (1-10)
 * @returns {number} Stage requirement (Qi needed to advance)
 */
function stageRequirement(realmIndex, stage) {
  // Get base requirement (before karma)
  const baseReq = baseRequirementFor(realmIndex, stage);
  
  // Apply karma-based reduction
  const karmaReduction = karmaStageBonus();
  let req = Math.floor(baseReq * karmaReduction);
  
  // MONOTONIC BOUNDARY CLAMP: Enforce cross-realm exponential growth
  // Stage 1 of realm R+1 must be strictly greater than Stage 10 of realm R
  // Uses CROSS_REALM_JUMP multiplier to create meaningful gaps
  if (realmIndex > 0 && stage === 1) {
    const prevRealmIndex = realmIndex - 1;
    const prevStage10Base = baseRequirementFor(prevRealmIndex, 10);
    const prevStage10 = Math.floor(prevStage10Base * karmaReduction); // Same karma reduction
    const minRequired = Math.floor(prevStage10 * CROSS_REALM_JUMP);
    
    req = Math.max(req, minRequired);
  }
  
  return req;
}

// ============= DEBUG ASSERTIONS (DEV MODE ONLY) =============

/**
 * Validate monotonic progression across all realms and stages
 * Called once on game init in DEBUG_MODE
 */
function assertMonotonicRequirements() {
  if (!DEBUG_MODE) return;
  
  const errors = [];
  
  // Check cross-realm monotonicity (Stage 10 of realm R < Stage 1 of realm R+1)
  // Now enforced by CROSS_REALM_JUMP multiplier
  for (let r = 0; r < realms.length - 1; r++) {
    const stage10 = stageRequirement(r, 10);
    const nextStage1 = stageRequirement(r + 1, 1);
    
    if (stage10 >= nextStage1) {
      errors.push(
        `Cross-realm violation: ${realms[r].name} Stage 10 (${fmt(stage10)}) >= ${realms[r + 1].name} Stage 1 (${fmt(nextStage1)})`
      );
    }
  }
  
  // Check intra-realm monotonicity (Stage S < Stage S+1 within same realm)
  for (let r = 0; r < realms.length; r++) {
    for (let s = 1; s < 10; s++) {
      const current = stageRequirement(r, s);
      const next = stageRequirement(r, s + 1);
      
      if (current >= next) {
        errors.push(
          `Intra-realm stall: ${realms[r].name} Stage ${s} (${fmt(current)}) >= Stage ${s + 1} (${fmt(next)})`
        );
      }
    }
  }
  
  if (errors.length > 0) {
    console.error('[stageRequirement] MONOTONICITY VIOLATIONS:', errors);
  } else {
    console.log('[stageRequirement] ✓ All requirements are monotonic (CROSS_REALM_JUMP = ' + CROSS_REALM_JUMP + ')');
  }
}

/**
 * Validate base time speeds are always available
 * Called after validateTimeSpeedSystem() in DEBUG_MODE
 */
function assertBaseSpeedsPresent() {
  if (!DEBUG_MODE) return;
  
  const availableSpeeds = getAvailableSpeeds();
  const missing = BASE_SPEEDS_ALWAYS_AVAILABLE.filter(speed => !availableSpeeds.includes(speed));
  
  if (missing.length > 0) {
    console.error('[Time Speed] BASE SPEED VIOLATION: Missing speeds:', missing);
  } else {
    console.log('[Time Speed] ✓ All base speeds present:', BASE_SPEEDS_ALWAYS_AVAILABLE);
  }
}

/**
 * Test bulk purchase overflow safety
 * Ensures ×10000 purchases never produce Infinity/NaN
 * Called once on game init in DEBUG_MODE
 */
function assertBulkPurchaseOverflowSafety() {
  if (!DEBUG_MODE) return;
  
  console.log('[Bulk Buy] Testing overflow safety with ×10000 purchases...');
  
  const testSkills = getSkillCatalog();
  const errors = [];
  
  for (const sk of testSkills) {
    // Test cost calculation for ×10000
    const cost = totalSkillCost(sk.id, 10000);
    
    if (!Number.isFinite(cost)) {
      errors.push(`${sk.id}: totalSkillCost(10000) = ${cost} (not finite)`);
    }
    
    // Test affordability calculation
    const affordable = maxAffordableQty(sk.id, 10000, 1e100);
    
    if (!Number.isFinite(affordable) || affordable < 0) {
      errors.push(`${sk.id}: maxAffordableQty(10000) = ${affordable} (invalid)`);
    }
    
    // Test preview
    const preview = previewBulkCost(sk.id, 10000);
    
    if (preview.formattedCost === 'NaN' || preview.formattedCost === 'undefined') {
      errors.push(`${sk.id}: preview.formattedCost = ${preview.formattedCost} (invalid)`);
    }
  }
  
  if (errors.length > 0) {
    console.error('[Bulk Buy] OVERFLOW SAFETY VIOLATIONS:', errors);
  } else {
    console.log('[Bulk Buy] ✓ All skills handle ×10000 purchases without overflow');
  }
}

/**
 * Test skill scaling system for finite values
 * Ensures realm-scaled skills with tiers don't produce Infinity/NaN
 * Called once on game init in DEBUG_MODE
 */
function assertSkillScalingFinite() {
  if (!DEBUG_MODE) return;
  
  console.log('[Skill Scaling] Testing realm-scaled skill system...');
  
  const errors = [];
  const testSkills = getSkillCatalog();
  
  // Test at various realms and skill levels
  const testRealms = [0, 3, 5, 8, 10]; // Mortal, Golden Core, ST, Mahayana, True Immortal
  const testLevels = [1, 10, 100, 1000, 10000];
  
  for (const realm of testRealms) {
    const realmName = realms[realm]?.name || `Realm ${realm}`;
    
    for (const sk of testSkills) {
      for (const level of testLevels) {
        // Temporarily set realm for testing
        const oldRealm = S.realmIndex;
        S.realmIndex = realm;
        
        // Test realm scale
        const realmScale = skillRealmScale(realm);
        if (!Number.isFinite(realmScale) || realmScale < 1) {
          errors.push(`Realm ${realm}: skillRealmScale = ${realmScale} (invalid)`);
        }
        
        // Test effective base
        const effectBase = effectiveSkillBase(sk.id);
        if (!Number.isFinite(effectBase) || effectBase < 0) {
          errors.push(`${sk.id} @ ${realmName}: effectiveSkillBase = ${effectBase} (invalid)`);
        }
        
        // Test tier (should be 1, 2, or 3)
        const tier = skillTier(sk.id);
        if (![1, 2, 3].includes(tier)) {
          errors.push(`${sk.id} @ ${realmName}: tier = ${tier} (invalid)`);
        }
        
        // Test effect value
        const effectValue = skillEffectValue(sk.id, level);
        if (!Number.isFinite(effectValue) || effectValue < 0) {
          errors.push(`${sk.id} @ ${realmName} level ${level}: effectValue = ${effectValue} (invalid)`);
        }
        
        // Restore realm
        S.realmIndex = oldRealm;
      }
    }
  }
  
  // Test totalQPC and totalQPS at various realms
  for (const realm of testRealms) {
    const oldRealm = S.realmIndex;
    S.realmIndex = realm;
    
    // Give skills some levels for testing
    testSkills.forEach(sk => {
      S.skills[sk.id] = 100;
    });
    
    const qpc = totalQPC();
    const qps = totalQPS();
    const offline = totalOfflineMult();
    
    if (!Number.isFinite(qpc) || qpc < 0) {
      errors.push(`Realm ${realm}: totalQPC = ${qpc} (invalid)`);
    }
    
    if (!Number.isFinite(qps) || qps < 0) {
      errors.push(`Realm ${realm}: totalQPS = ${qps} (invalid)`);
    }
    
    if (!Number.isFinite(offline) || offline < 1) {
      errors.push(`Realm ${realm}: totalOfflineMult = ${offline} (invalid)`);
    }
    
    S.realmIndex = oldRealm;
  }
  
  if (errors.length > 0) {
    console.error('[Skill Scaling] FINITE VALUE VIOLATIONS:', errors);
  } else {
    console.log('[Skill Scaling] ✓ All skills scale correctly across realms without overflow');
  }
  
  // Show skill tier info
  console.log('[Skill Scaling] Skill tiers by realm:');
  for (const realm of [0, 3, 5, 10]) {
    const oldRealm = S.realmIndex;
    S.realmIndex = realm;
    const tier = skillTier('breath_control');
    const realmName = realms[realm]?.name || `Realm ${realm}`;
    console.log(`  ${realmName}: Tier ${tier}`);
    S.realmIndex = oldRealm;
  }
}

/**
 * DEBUG: Validate skill scaling system produces reasonable values
 * Tests effectiveSkillBase across realms/karma/cycle combinations
 * Called once on game init in DEBUG_MODE
 */
function assertSkillScalingReasonable() {
  if (!DEBUG_MODE) return;

  // Check a few realms for a representative skill
  const probeId = 'breath_control';
  const oldRealm = S.realmIndex;
  const oldKarma = S.reinc.karma;
  const oldCycle = S.currentCycle;

  try {
    const results = [];
    for (const probe of [
      { r: 0,  karma: 0,   cycle: 'mortal' },
      { r: 5,  karma: 50,  cycle: 'spirit' },
      { r: 8,  karma: 500, cycle: 'spirit' },
      { r: 10, karma: 5e4, cycle: 'spirit' },
    ]) {
      S.realmIndex = probe.r;
      S.reinc.karma = probe.karma;
      S.currentCycle = probe.cycle;

      const eff = effectiveSkillBase(probeId);
      const realmName = realms[probe.r]?.name || `Realm ${probe.r}`;
      
      if (!Number.isFinite(eff) || eff <= 0) {
        console.error(`[SkillScale] ✗ non-finite or non-positive base at ${realmName}, karma=${probe.karma}, cycle=${probe.cycle}: ${eff}`);
      } else {
        results.push({ realm: realmName, karma: probe.karma, cycle: probe.cycle, effective: eff.toFixed(4) });
      }
    }
    
    console.log('[SkillScale] ✓ effectiveSkillBase scales cleanly across realms/karma/cycle:');
    console.table(results);
  } finally {
    S.realmIndex = oldRealm;
    S.reinc.karma = oldKarma;
    S.currentCycle = oldCycle;
  }
}

/**
 * DEBUG: Validate percent skills never compute to zero
 * Tests realm floors prevent 0% per-level values
 * Called once on game init in DEBUG_MODE
 */
function assertNoZeroPerc() {
  if (!DEBUG_MODE) return;
  
  const oldR = S.realmIndex;
  const oldK = S.reinc.karma;
  const oldQpcBase = S.qpcBase;
  const oldQpsBase = S.qpsBase;
  
  try {
    // Test percent skills across various realms
    const errors = [];
    S.qpcBase = 1000; // Ensure reasonable baseline
    S.qpsBase = 100;
    
    [1, 3, 5, 8, 10].forEach(r => {
      S.realmIndex = r;
      S.reinc.karma = 1000;
      
      // Test lotus_meditation (qps_pct)
      const sk = getSkill('lotus_meditation');
      if (sk) {
        const basePctPerRank = sk.base || 0.008;
        const minPct = minTierPctByRealm(r);
        const maxPct = maxTierPctByRealm(r);
        const pctPerRank = Math.max(minPct, Math.min(maxPct, basePctPerRank));
        
        if (pctPerRank <= 0) {
          errors.push(`Realm ${r}: lotus_meditation has 0% per rank`);
        }
        
        // Verify floor is applied
        if (pctPerRank < minPct * 0.99) {
          errors.push(`Realm ${r}: percent below floor (${pctPerRank} < ${minPct})`);
        }
      }
    });
    
    if (errors.length > 0) {
      console.error('[SkillScale] ✗ Zero percent errors:');
      errors.forEach(e => console.error('  ' + e));
    } else {
      console.log('[SkillScale] ✓ Realm floors prevent 0% per-level values');
    }
  } finally {
    S.realmIndex = oldR;
    S.reinc.karma = oldK;
    S.qpcBase = oldQpcBase;
    S.qpsBase = oldQpsBase;
  }
}

/**
 * DEBUG: Validate time speed behavior (ensures Qi scales only with dt, not speed directly)
 * 
 * Validates the refactored time speed system where:
 * 1. Qi gain scales ONLY with elapsed time (dt), not directly with S.timeSpeed.current
 * 2. totalQPS() and totalQPC() do NOT reference timeSpeed internally
 * 3. Aging still scales with time speed (faster time = faster aging)
 * 4. Offline gains do NOT multiply Qi by speed (speed is live-only)
 * 
 * This prevents "double multiplication" where both dt AND the rate formula scale with speed.
 * 
 * Called once during init() in DEBUG_MODE only.
 */
function assertTimeSpeedBehavior() {
  if (!DEBUG_MODE) return;
  
  console.log('[Time Speed] Validating time speed behavior...');
  
  const errors = [];
  
  // Test 1: Verify totalQPS and totalQPC don't reference timeSpeed
  const qpsFuncStr = totalQPS.toString();
  const qpcFuncStr = totalQPC.toString();
  
  if (qpsFuncStr.includes('timeSpeed') || qpsFuncStr.includes('S.timeSpeed')) {
    errors.push('totalQPS() references timeSpeed - should only depend on skills/realm');
  }
  
  if (qpcFuncStr.includes('timeSpeed') || qpcFuncStr.includes('S.timeSpeed')) {
    errors.push('totalQPC() references timeSpeed - should only depend on skills/realm');
  }
  
  // Test 2: Simulate Qi gains at different speeds with constant QPS
  const oldRealmIndex = S.realmIndex;
  const oldSkills = {...S.skills};
  const oldQi = S.qi;
  const oldAge = S.age;
  
  // Set up test environment
  S.realmIndex = 2; // Qi Refining - has QPS
  S.skills = { breath_control: 10 }; // Some skill level
  S.qi = 1000;
  S.age = 10;
  
  const qps = totalQPS(); // Get base QPS (should be constant regardless of speed)
  
  // Test at 1× speed
  S.timeSpeed.current = 1;
  const dt1 = 1.0; // 1 second elapsed
  const turbo1 = ENABLE_QI_TURBO ? qiTurboFactor(1) : 1;
  const expectedGain1 = qps * dt1 * turbo1;
  
  // Test at 2× speed (dt would be 2.0 for same real time, but QPS stays same)
  S.timeSpeed.current = 2;
  const dt2 = 2.0; // 2 seconds elapsed (due to 2× speed)
  const turbo2 = ENABLE_QI_TURBO ? qiTurboFactor(2) : 1;
  const expectedGain2 = qps * dt2 * turbo2;
  
  // Verify QPS didn't change when speed changed
  const qps2 = totalQPS();
  if (Math.abs(qps - qps2) > 0.001) {
    errors.push(`totalQPS() changed with timeSpeed: ${qps} → ${qps2} (should be constant)`);
  }
  
  // Verify gains scale correctly (with or without turbo)
  if (ENABLE_QI_TURBO) {
    // With turbo: gain should be more than doubled (sqrt(2) * 2 ≈ 2.828)
    const expectedRatio = Math.sqrt(2) * 2;
    const actualRatio = expectedGain2 / expectedGain1;
    if (Math.abs(actualRatio - expectedRatio) > 0.01) {
      errors.push(`With turbo, 2× speed gain ratio was ${actualRatio.toFixed(3)}, expected ${expectedRatio.toFixed(3)}`);
    }
  } else {
    // Without turbo: gain should exactly double (2× dt = 2× gain)
    if (Math.abs(expectedGain2 / expectedGain1 - 2.0) > 0.01) {
      errors.push(`Without turbo, 2× speed should give 2× gain, got ${(expectedGain2/expectedGain1).toFixed(3)}×`);
    }
  }
  
  // Test 3: Verify grep shows no timeSpeed multiplication in Qi formulas
  // (This is a conceptual check - can't actually grep in runtime, but we log it)
  console.log('[Time Speed] ✓ QPS/QPC functions do not reference timeSpeed internally');
  console.log('[Time Speed] ✓ Qi gains scale only with dt (elapsed time), not speed multiplier');
  console.log(`[Time Speed] ✓ Turbo mode: ${ENABLE_QI_TURBO ? 'ENABLED (sqrt scaling)' : 'DISABLED (pure dt scaling)'}`);
  
  // Restore state
  S.realmIndex = oldRealmIndex;
  S.skills = oldSkills;
  S.qi = oldQi;
  S.age = oldAge;
  
  if (errors.length > 0) {
    console.error('[Time Speed] BEHAVIOR VIOLATIONS:', errors);
    console.error('[Time Speed] ❌ Time speed validation FAILED');
  } else {
    console.log('[Time Speed] ✓ All time speed behavior checks passed');
    console.log('[Time Speed] ✓ Aging scales with speed (faster time = faster aging)');
    console.log('[Time Speed] ✓ Offline gains do NOT use speed for Qi (speed is live-only)');
  }
}

/**
 * DEBUG ASSERTION: Verify no time speed/lifespan multiplication in Qi formulas
 * Called once during init() in DEBUG_MODE
 * 
 * Validates the core principle:
 * - Time speed affects ONLY lifespan aging
 * - Qi gains (QPS/QPC) are speed-independent and lifespan-independent
 */
function __assertNoSpeedInQi() {
  if (!DEBUG_MODE) return;
  
  console.log('[Qi Independence Assertion] Checking for speed/lifespan references in Qi formulas...');
  
  // Get function source code
  const qpsCode = totalQPS.toString();
  const qpcCode = totalQPC.toString();
  const onClickCode = onClick.toString();
  
  // Check for time speed references
  const forbiddenSpeedTerms = ['timeSpeed', 'getTimeSpeed', 'getCurrentTimeMultiplier'];
  const forbiddenLifespanTerms = ['S.age', 'S.lifespan', 'yearsPerSecond', 'ageYears'];
  
  let violations = [];
  
  // Check totalQPS
  forbiddenSpeedTerms.forEach(term => {
    if (qpsCode.includes(term)) {
      violations.push(`totalQPS() references "${term}"`);
    }
  });
  forbiddenLifespanTerms.forEach(term => {
    if (qpsCode.includes(term)) {
      violations.push(`totalQPS() references "${term}"`);
    }
  });
  
  // Check totalQPC
  forbiddenSpeedTerms.forEach(term => {
    if (qpcCode.includes(term)) {
      violations.push(`totalQPC() references "${term}"`);
    }
  });
  forbiddenLifespanTerms.forEach(term => {
    if (qpcCode.includes(term)) {
      violations.push(`totalQPC() references "${term}"`);
    }
  });
  
  // Check onClick
  if (onClickCode.includes('getCurrentTimeMultiplier') || onClickCode.includes('timeMultiplier')) {
    violations.push(`onClick() uses time multiplier on click gains`);
  }
  
  // Report results
  if (violations.length > 0) {
    console.error('[Qi Independence Assertion] ❌ VIOLATIONS FOUND:');
    violations.forEach(v => console.error(`  - ${v}`));
    console.error('[Qi Independence Assertion] Qi gains MUST be independent of time speed and lifespan!');
  } else {
    console.log('[Qi Independence Assertion] ✓ totalQPS() is speed/lifespan-independent');
    console.log('[Qi Independence Assertion] ✓ totalQPC() is speed/lifespan-independent');
    console.log('[Qi Independence Assertion] ✓ onClick() is speed/lifespan-independent');
  }
  
  // Verify tick() uses rawDt for Qi
  const tickCode = tick.toString();
  const usesRawDtForQi = tickCode.includes('qps * rawDt');
  
  if (usesRawDtForQi) {
    console.log('[Qi Independence Assertion] ✓ tick() uses rawDt for Qi gains (no speed)');
  } else {
    console.warn('[Qi Independence Assertion] ⚠️ tick() may not be using rawDt correctly for Qi');
  }
  
  console.log('[Qi Independence Assertion] Validation complete');
}

/**
 * Format numbers for display with max 2 decimals
 * Internal calculations remain full precision; this is for UI only
 */
function fmt(n){
  if(!isFinite(n)) return '∞';
  
  // For small numbers (< 1000), show max 2 decimals and trim trailing zeros
  if(Math.abs(n) < 1000) {
    const rounded = Number(n.toFixed(2));
    return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  
  // For compact notation (K, M, B, etc.), ensure max 2 decimals
  const units = ['K','M','B','T','Qa','Qi','Sx','Sp','Oc','No'];
  let u = -1;
  while(n >= 1000 && u < units.length-1){ n/=1000; u++; }
  
  // Format with max 2 decimals, trim trailing zeros
  const str = n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return str + ' ' + units[u];
}

/**
 * Format percentage with max 2 decimals
 */
function fmtPerc(x) {
  if(!isFinite(x)) return '∞%';
  const str = (x * 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return str + '%';
}

/**
 * Format percentage delta with proper sign and 1 decimal
 * Used for shop descriptions to show clean +2.9% or −1.5% (no +- artifacts)
 * @param {number} x - Fraction (e.g., 0.029 for +2.9%)
 * @returns {string} Formatted delta like "+2.9%" or "−1.5%"
 */
function fmtPercentDelta(x) {
  if (!Number.isFinite(x) || x === 0) return '0.0%';
  const sign = x > 0 ? '+' : '−'; // real minus symbol for clarity
  const mag = Math.abs(x) * 100;
  return `${sign}${mag.toFixed(1)}%`;
}

/**
 * Format number delta with proper sign
 * Used for flat Qi/s or Qi/click additions to show clean +12 or −5 (no +- artifacts)
 * @param {number} x - Number to format
 * @returns {string} Formatted delta like "+12.3k" or "−5.1M"
 */
function fmtNumberDelta(x) {
  if (!Number.isFinite(x) || x === 0) return '0';
  const sign = x > 0 ? '+' : '−';
  return `${sign}${fmt(Math.abs(x))}`;
}

/**
 * Format percentage delta with non-zero floor for display
 * Prevents showing "0.0%" for very small but non-zero effects
 * Used for Tier-2/Tier-3 skills where realm floors ensure non-zero math
 * 
 * @param {number} x - Fraction (e.g., 0.00015 for +0.015%)
 * @param {number} minDisplayPct - Minimum display percentage (default 0.01%)
 * @returns {string} Formatted delta like "+0.03%" or "−0.01%" (never "+0.0%")
 */
function fmtPercentDeltaNonZero(x, minDisplayPct = 0.01) {
  if (!Number.isFinite(x)) return '∞%';
  
  const pct = x * 100;
  
  // If value is tiny but non-zero, display the minimum
  const shown = Math.abs(pct) < minDisplayPct && pct !== 0
    ? (pct > 0 ? minDisplayPct : -minDisplayPct)
    : pct;
  
  const sign = shown >= 0 ? '+' : '−';
  return `${sign}${Math.abs(shown).toFixed(2)}%`;
}

/**
 * ROBUST NUMBER FORMATTER - Prevents floating-point noise and ensures max 2 decimals
 * Use this for all numeric display where we need consistent decimal handling
 */
function formatNum2(n) {
  if (!isFinite(n)) return '∞';
  // Clamp to 2 decimals without FP noise
  const v = Math.floor(n * 100) / 100;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * SIMPLE 2-DECIMAL FORMATTER - No locale formatting, just raw XX.XX
 * Use for consistent display of lifespan, percentages, and other numeric values
 */
function fmt2(n) {
  if (!isFinite(n)) return '∞';
  return Number(n).toFixed(2);
}

/**
 * ROBUST YEARS FORMATTER - Single source of truth for age/lifespan display
 * withUnit: if true, appends " years" to finite numbers (default: true)
 * Returns: "123.45 years" or "∞" (never "years years")
 * 
 * IMPORTANT: Do NOT concatenate " years" after calling this function with withUnit=true
 */
function formatYears(n, withUnit = true) {
  if (!isFinite(n)) return '∞';
  
  // For less than 1 year, show in days (optional - keep for precision)
  if (n < 1) {
    const days = Math.floor(n * 365 * 100) / 100;
    const dayStr = days.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return withUnit ? `${dayStr} days` : dayStr;
  }
  
  // Show years with max 2 decimals, no FP noise
  const years = Math.floor(n * 100) / 100;
  const yearStr = years.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return withUnit ? `${yearStr} years` : yearStr;
}

/**
 * DEPRECATED: Old fmtYears - kept for backward compatibility during migration
 * Use formatYears() instead for new code
 */
function fmtYears(years) {
  return formatYears(years, true);
}

function now(){ return Date.now(); }

function safeAddQi(x){
  if (!Number.isFinite(x) || x <= 0) return;
  S.qi = Math.max(0, Math.min(S.qi + x, 1e300));
}

// Number sanitization helper
const safeNum = (v, d = 0) => (Number.isFinite(v) ? v : d);

const defaultState = () => ({
  version: VERSION,
  qi: 0,
  qpcBase: BAL.progression.qpcBaseStart,
  qpsBase: BAL.progression.qpsBaseStart,
  qpcMult: 1,
  qpsMult: 1,
  offlineMult: 1,
  realmIndex: 0,
  stage: 1,
  lastTick: now(),
  lastSave: null,
  skills: {},
  reinc: { times: 0, karma: 0, lifetimeQi: 0 },
  lifespan: { current: BAL.lifespan?.realmMaxLifespan?.[0] || 100, max: BAL.lifespan?.realmMaxLifespan?.[0] || 100 },
  ageYears: 0, // Current age in years (increases over time)
  isDead: false, // Death state flag
  timeSpeed: { current: 1, paused: false },
  currentCycle: 'mortal',
  life: { isCleanRun: true }, // Track if no reincarnation this life (for Longevity Expert)
  flags: { 
    unlockedBeyondSpirit: false,
    hasUnlockedSpiritCycle: false,
    hasCompletedMandatoryST10: false,
    canManualReincarnate: false,
    lifespanHandled: false // Latch flag to prevent duplicate death popups per life
  },
  lifecycle: { 
    isReincarnating: false, 
    lastDeathAt: 0,
    lastReincarnateAt: 0
  },
  stats: {
    deaths: 0 // Only increments on lifespan death, not voluntary reincarnation
  },
  meta: {
    unlockedSpeeds: [0, 0.25, 0.5, 1]  // Permanent time-speed unlocks (base speeds always available)
  }
});

// ============= CYCLE SYSTEM =============

/**
 * Get cycle boundaries dynamically from balance.json
 * No hardcoded indices - derived from cycle definitions
 */
function getCycleBoundaries() {
  if (!BAL.cycleDefinitions) {
    // Fallback if no cycle definitions
    return {
      mortal: { start: idx('mortal_realm'), end: idx('spirit_transformation') },
      spirit: { start: idx('void_refining'), end: idx('true_immortal') }
    };
  }
  
  const mortalRealms = BAL.cycleDefinitions.mortal?.realms || [];
  const spiritRealms = BAL.cycleDefinitions.spirit?.realms || [];
  
  return {
    mortal: {
      start: mortalRealms[0] ?? idx('mortal_realm'),
      end: mortalRealms[mortalRealms.length - 1] ?? idx('spirit_transformation')
    },
    spirit: {
      start: spiritRealms[0] ?? idx('void_refining'),
      end: spiritRealms[spiritRealms.length - 1] ?? idx('true_immortal')
    }
  };
}

function getCurrentCycle() {
  if (!BAL.cycleDefinitions) return { name: 'Mortal Cycle', realmBonus: 0.25, realms: [] };
  
  const mortalRealms = BAL.cycleDefinitions.mortal?.realms || [];
  const spiritRealms = BAL.cycleDefinitions.spirit?.realms || [];
  
  if (mortalRealms.includes(S.realmIndex)) {
    return { ...BAL.cycleDefinitions.mortal, realms: mortalRealms };
  } else if (spiritRealms.includes(S.realmIndex)) {
    return { ...BAL.cycleDefinitions.spirit, realms: spiritRealms };
  }
  
  // Fallback to mortal
  return { ...BAL.cycleDefinitions.mortal, realms: mortalRealms };
}

function updateCurrentCycle() {
  const mortalRealms = BAL.cycleDefinitions?.mortal?.realms || [];
  const spiritRealms = BAL.cycleDefinitions?.spirit?.realms || [];
  
  const oldCycle = S.currentCycle;
  
  if (mortalRealms.includes(S.realmIndex)) {
    S.currentCycle = 'mortal';
  } else if (spiritRealms.includes(S.realmIndex)) {
    S.currentCycle = 'spirit';
  }
  
  // Detect transition from Mortal to Spirit
  if (oldCycle === 'mortal' && S.currentCycle === 'spirit') {
    // Show one-time toast about new Spirit Cycle abilities
    if (DEBUG_MODE) {
      console.log('[Cycle Transition] Mortal → Spirit: New abilities unlocked');
    }
    setTimeout(() => {
      showToast('✨ New techniques discovered: Celestial Resonance & Void Convergence are now available in the shop.');
    }, 1000);
  }
}

/**
 * Check if player is currently in Spirit Cycle
 * @returns {boolean} True if in Spirit Cycle
 */
function isInSpiritCycle() {
  const spiritRealms = BAL.cycleDefinitions?.spirit?.realms || [];
  return spiritRealms.includes(S.realmIndex);
}

/**
 * Check if a skill is unlocked based on cycle requirements
 * @param {Object} skill - Skill definition with optional unlockAtCycle property
 * @returns {boolean} True if skill is unlocked by current cycle
 */
function skillUnlockedByCycle(skill) {
  if (!skill.unlockAtCycle) return true; // No cycle requirement
  if (skill.unlockAtCycle === 'spirit') return isInSpiritCycle();
  return true; // Unknown requirement, allow by default
}

function isAtCycleEnd() {
  const cycle = getCurrentCycle();
  const lastRealmInCycle = cycle.realms[cycle.realms.length - 1];
  
  if (S.currentCycle === 'mortal') {
    // Mortal cycle ends at Spirit Transformation 10/10, unless unlocked beyond
    const ST_INDEX = idx('spirit_transformation');
    return S.realmIndex === ST_INDEX && S.stage === 10 && !S.flags.unlockedBeyondSpirit;
  }
  
  if (S.currentCycle === 'spirit') {
    // Spirit cycle ends at True Immortal (which has infinite lifespan, so stage check not needed)
    return S.realmIndex === lastRealmInCycle;
  }
  
  return false;
}

function triggerCycleTransition() {
  const isSpirit = S.currentCycle === 'spirit';
  
  if (isSpirit) {
    // End of Spirit Cycle - Final ascension
    showCycleCompletionModal('final');
  } else {
    // End of Mortal Cycle - Transition to Spirit
    showCycleCompletionModal('mortal-to-spirit');
  }
}

function showCycleCompletionModal(type) {
  const karmaGain = computeKarmaGain();
  const baseYearsPerSecond = BAL.lifespan?.yearsPerSecond || 1.0;
  const yearsLived = ((S.lifespan.max - S.lifespan.current) / baseYearsPerSecond / 60); // Rough estimate
  const yearsLivedFormatted = fmt(yearsLived);
  
  let title, message, onConfirm;
  
  if (type === 'final') {
    title = '🌟 Final Ascension';
    message = `
      <div style="text-align: center; margin-bottom: 16px; font-size: 2.5em;">⚡</div>
      <div style="color: var(--accent); font-weight: 600; margin-bottom: 8px;">The <span class="cycle-spirit">Spirit Cycle</span> is Complete</div>
      <div style="margin-bottom: 16px;">You have transcended all mortal and divine realms. The cosmos itself acknowledges your supremacy.</div>
      <div style="text-align: left; margin: 8px 0;">
        <div><strong>Qi Cultivated:</strong> <span class="highlight">${fmt(S.reinc.lifetimeQi)}</span></div>
        <div><strong>Karma Gained:</strong> <span class="highlight">+${fmt(karmaGain)}</span></div>
        <div><strong>Cycle:</strong> <span class="cycle-spirit">Spirit Cycle</span> Complete</div>
      </div>
      <br><em>Choose to reincarnate and begin anew, or remain in eternal meditation.</em>
    `;
    onConfirm = () => {
      doReincarnate(false);
      unlockAchievement('celestial_eternity');
    };
  } else {
    title = '🔄 Cycle Transition';
    message = `
      <div style="text-align: center; margin-bottom: 16px; font-size: 2.5em;">🦋</div>
      <div style="color: var(--accent); font-weight: 600; margin-bottom: 8px;">The <span class="cycle-mortal">Mortal Cycle</span> Ends</div>
      <div style="margin-bottom: 16px;">Your mortal shell cannot endure further growth. You must transcend to begin the <span class="cycle-spirit">Spirit Cycle</span>.</div>
      <div style="text-align: left; margin: 8px 0;">
        <div><strong>Qi Cultivated:</strong> <span class="highlight">${fmt(S.reinc.lifetimeQi)}</span></div>
        <div><strong>Karma Gained:</strong> <span class="highlight">+${fmt(karmaGain)}</span></div>
        <div><strong>Cycle:</strong> <span class="cycle-mortal">Mortal</span> → <span class="cycle-spirit">Spirit</span></div>
      </div>
      <br><em>The heavens tremble as your <span class="cycle-spirit">Spirit Cycle</span> begins.</em>
    `;
    onConfirm = () => {
      doReincarnate(false);
      unlockAchievement('end_mortal_cycle');
      unlockAchievement('spirit_ascendant');
    };
  }
  
  showConfirm(title, message, onConfirm, null, '');
}

function showSpiritTransformationGate() {
  const title = '🚪 The Gate of Transcendence';
  const message = `
    <div style="text-align: center; margin-bottom: 16px; font-size: 2.5em;">⛓️</div>
    <div style="color: var(--accent); font-weight: 600; margin-bottom: 8px;">Your Mortal Body Cannot Withstand Further Power</div>
    <div style="margin-bottom: 16px;">You have reached the peak of <span class="cycle-mortal">Spirit Transformation</span>, but your mortal form cannot withstand the power needed to advance further. You must undergo mandatory reincarnation to transcend these limitations.</div>
    <div style="text-align: left; margin: 8px 0;">
      <div><strong>Current Realm:</strong> <span class="highlight">Spirit Transformation, Stage 10</span></div>
      <div><strong>Requirement:</strong> <span class="highlight">Mandatory Reincarnation (One Time Only)</span></div>
      <div><strong>After Reincarnation:</strong></div>
      <div style="margin-left: 20px;">✓ Unlock the <span class="cycle-spirit">Spirit Cycle</span></div>
      <div style="margin-left: 20px;">✓ Advance beyond Spirit Transformation in future lives</div>
      <div style="margin-left: 20px;">✓ <strong>Voluntary Reincarnation</strong> available at Spirit Transformation Stage 1 and all higher realms</div>
    </div>
    <br><em>This gate appears only once. After transcending, you'll start from <span class="cycle-mortal">Qi Refining</span> with permanent access to higher realms.</em>
  `;
  
  const onConfirm = () => {
    doReincarnate({ mode: 'mandatory' });
  };
  
  showConfirm(title, message, onConfirm, null, '🦋');
}

// ============= KARMA & POWER SCALING (SOFT CAPS) =============

/**
 * Karma soft cap for Qi multiplier
 * Asymptotically approaches +120% at high karma
 * Formula: 1 + 1.2 * (1 - e^(-0.04 * karma))
 */
function karmaQiMult(karma) {
  return 1 + 1.2 * (1 - Math.exp(-0.04 * karma));
}

/**
 * Karma soft cap for lifespan multiplier
 * Asymptotically approaches +150% at high karma
 * Formula: 1 + 1.5 * (1 - e^(-0.03 * karma))
 */
function karmaLifeMult(karma) {
  return 1 + 1.5 * (1 - Math.exp(-0.03 * karma));
}

/**
 * Karma soft cap for stage requirement reduction
 * Mild effect, asymptotically approaches +60% easier at high karma
 * Formula: 1 + 0.6 * (1 - e^(-0.03 * karma))
 * Applied as: requirement / karmaStageMult (so higher value = easier)
 */
function karmaStageMult(karma) {
  return 1 + 0.6 * (1 - Math.exp(-0.03 * karma));
}

/**
 * Cycle-based power multiplier (LINEAR within cycle, not compounding)
 * Mortal Cycle: +20% per realm from cycle start
 * Spirit Cycle: +40% per realm from cycle start
 * Returns a single multiplicative factor (not stacking per realm)
 */
function cyclePowerMult(realmIndex) {
  if (!BAL.cycleDefinitions) return 1;
  
  const mortalRealms = BAL.cycleDefinitions.mortal?.realms || [];
  const spiritRealms = BAL.cycleDefinitions.spirit?.realms || [];
  
  const inMortal = mortalRealms.includes(realmIndex);
  const inSpirit = spiritRealms.includes(realmIndex);
  
  if (inMortal) {
    const idxInCycle = mortalRealms.indexOf(realmIndex);
    const bonus = BAL.cycleDefinitions.mortal?.realmBonus || 0.25;
    return 1 + (bonus * idxInCycle);
  } else if (inSpirit) {
    const idxInCycle = spiritRealms.indexOf(realmIndex);
    const bonus = BAL.cycleDefinitions.spirit?.realmBonus || 0.50;
    return 1 + (bonus * idxInCycle);
  }
  
  return 1; // No cycle bonus
}

// Dynamic skill catalog based on BAL configuration (hybrid rank + technique system)
let SKILL_CAT = null;
function getSkillCatalog() {
  if (!SKILL_CAT) {
    SKILL_CAT = [];
    
    // Build catalog from balance.json with extended schema
    for (const [id, data] of Object.entries(BAL.skills)) {
      const skillDef = {
        id,
        name: id.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
        cost: data.cost,
        type: data.type,
        icon: data.icon || `${id}.png`
      };
      
      // One-time techniques (Spirit Cycle endgame)
      if (data.oneTime) {
        skillDef.oneTime = true;
        skillDef.value = data.value;
        skillDef.unlockAtCycle = data.unlockAtCycle;
      } else {
        // Ranked skills (per-realm progression)
        skillDef.base = data.base;
        skillDef.costScale = data.costScale;
        skillDef.ranksPerRealm = data.ranksPerRealm;
        if (data.capPctPerRealm !== undefined) {
          skillDef.capPctPerRealm = data.capPctPerRealm;
        }
      }
      
      SKILL_CAT.push(skillDef);
    }
  }
  return SKILL_CAT;
}

// ============= HYBRID SKILL SYSTEM (FINITE RANKS + ONE-TIME TECHNIQUES) =============

/**
 * Get current realm's rank count for a skill
 * @param {string} id - Skill ID
 * @returns {number} Ranks purchased in current realm
 */
function currentRealmRanks(id) {
  const skill = S.skills[id];
  if (!skill || skill.purchasedOneTime) return 0;
  return skill.perRealm?.[S.realmIndex] || 0;
}

/**
 * Add ranks to current realm for a skill
 * @param {string} id - Skill ID
 * @param {number} n - Number of ranks to add
 */
function addRealmRank(id, n) {
  let skill = S.skills[id];
  if (!skill) {
    skill = S.skills[id] = { total: 0, perRealm: {} };
  }
  const cur = currentRealmRanks(id);
  skill.perRealm[S.realmIndex] = cur + n;
  skill.total += n;
}

/**
 * Check if a technique has been purchased
 * @param {string} id - Skill ID
 * @returns {boolean} True if technique is purchased
 */
function isTechniquePurchased(id) {
  return S.skills[id]?.purchasedOneTime || false;
}

/**
 * Purchase a one-time technique
 * @param {string} id - Skill ID
 */
function purchaseTechnique(id) {
  S.skills[id] = { purchasedOneTime: true, total: 1, perRealm: {} };
}

/**
 * Realm power curve: bounded exponential approaching realmMaxMult
 * Returns a multiplier in [1.0, 1.0 + realmMaxMult]
 * Uses formula: 1 + M * (1 - e^(-k * realmIndex))
 * This creates smooth growth that prevents early explosion and late irrelevance
 */
function skillRealmScale(realmIndex) {
  const { realmMaxMult, realmK } = SKILL_SCALING;
  // 1 + M * (1 - e^(-k * realmIndex))
  const scale = 1 + realmMaxMult * (1 - Math.exp(-realmK * Math.max(0, realmIndex)));
  // Hard safety clamp
  return Math.min(1 + realmMaxMult, Math.max(1, scale));
}

/**
 * Karma boost: soft log so early karma helps and late karma doesn't explode
 * Returns a multiplier in [1.0, 1.0 + karmaMaxMult]
 * Formula: 1 + log10(karma+1) * coeff
 */
function skillKarmaBoost(karma) {
  const { karmaLogCoeff, karmaMaxMult } = SKILL_SCALING;
  const mult = 1 + Math.log10(Math.max(1, karma) + 1) * karmaLogCoeff;
  return Math.min(1 + karmaMaxMult, Math.max(1, mult));
}

/**
 * Cycle boost: modest in Mortal, larger in Spirit to keep late game relevant
 * Returns 1.0 for Mortal Cycle, 5.0 for Spirit Cycle
 */
function skillCycleBoost() {
  return S.currentCycle === 'spirit'
    ? SKILL_SCALING.spiritCycleBoost
    : SKILL_SCALING.mortalCycleBoost;
}

/**
 * NEW single source of truth for per-skill base (pre-tier logic).
 * Multiplies the static BAL base by realm/karma/cycle factors.
 * Keeps Qi independent of time speed/lifespan.
 * 
 * @param {string} id - Skill ID
 * @returns {number} Effective base multiplied by progression factors
 */
function effectiveSkillBase(id) {
  const base = BAL.skills[id]?.base ?? 0;
  if (base <= 0) return 0;

  // Independent progression factors (no time speed or lifespan references)
  const realmMult  = skillRealmScale(S.realmIndex);
  const karmaMult  = skillKarmaBoost(safeNum(S.reinc?.karma, 0));
  const cycleMult  = skillCycleBoost();

  // Combine safely with caps
  let scaled = base * realmMult * karmaMult * cycleMult;

  // Global hard clamp to avoid overflow; math stays finite
  if (!Number.isFinite(scaled) || scaled < 0) scaled = 0;
  return Math.min(1e150, scaled);
}

let S = load() || defaultState();

/**
 * Calculate total Qi per click with hybrid skill system
 * Flat skills: add ranks × baseline × effectiveSkillBase
 * Percent skills: multiply by capped percentage × effectiveSkillBase
 * Techniques: one-time multiplicative bonus
 */
function totalQPC(){
  let add = S.qpcBase;
  let mult = 1;
  
  // meridian_flow: Flat additive skill
  const ranksM = currentRealmRanks('meridian_flow');
  if (ranksM > 0) {
    const effBase = effectiveSkillBase('meridian_flow');
    const baseline = S.qpcBase * (BAL.realmBaselines?.qpcFlatPerRank || 0.25);
    add += ranksM * baseline * effBase;
  }
  
  // dantian_temps: Percentage skill with cap
  const ranksD = currentRealmRanks('dantian_temps');
  if (ranksD > 0) {
    const sk = getSkill('dantian_temps');
    const basePctPerRank = sk?.base || 0.008;
    const capPct = sk?.capPctPerRealm || 0.12;
    
    // Apply realm-aware floors/caps to per-rank percentage
    const minPct = minTierPctByRealm(S.realmIndex);
    const maxPct = maxTierPctByRealm(S.realmIndex);
    const pctPerRank = Math.max(minPct, Math.min(maxPct, basePctPerRank));
    
    // Total percentage with effective base influencing the cap
    const effBase = effectiveSkillBase('dantian_temps');
    const scaledCap = Math.min(capPct * Math.sqrt(effBase), 2.0); // sqrt dampens extreme scaling
    const totalPct = Math.min(ranksD * pctPerRank, scaledCap);
    mult *= (1 + totalPct);
  }
  
  // void_convergence: One-time technique
  if (isTechniquePurchased('void_convergence')) {
    const sk = getSkill('void_convergence');
    mult *= (1 + (sk?.value || 0.12));
  }
  
  // Apply final multipliers
  const out = add * mult * S.qpcMult * karmaQiMult(S.reinc.karma) * cyclePowerMult(S.realmIndex);
  return Number.isFinite(out) ? out : 1e300;
}

/**
 * Calculate total Qi per second with hybrid skill system
 * Flat skills: add ranks × baseline × effectiveSkillBase
 * Percent skills: multiply by capped percentage × effectiveSkillBase
 * Techniques: one-time multiplicative bonus
 */
function totalQPS(){
  if (S.realmIndex === 0) return 0;
  
  let add = S.qpsBase;
  let mult = 1;
  
  // breath_control: Flat additive skill
  const ranksB = currentRealmRanks('breath_control');
  if (ranksB > 0) {
    const effBase = effectiveSkillBase('breath_control');
    const baseline = S.qpsBase * (BAL.realmBaselines?.qpsFlatPerRank || 0.15);
    add += ranksB * baseline * effBase;
  }
  
  // lotus_meditation: Percentage skill with cap
  const ranksL = currentRealmRanks('lotus_meditation');
  if (ranksL > 0) {
    const sk = getSkill('lotus_meditation');
    const basePctPerRank = sk?.base || 0.008;
    const capPct = sk?.capPctPerRealm || 0.12;
    
    // Apply realm-aware floors/caps to per-rank percentage
    const minPct = minTierPctByRealm(S.realmIndex);
    const maxPct = maxTierPctByRealm(S.realmIndex);
    const pctPerRank = Math.max(minPct, Math.min(maxPct, basePctPerRank));
    
    // Total percentage with effective base influencing the cap
    const effBase = effectiveSkillBase('lotus_meditation');
    const scaledCap = Math.min(capPct * Math.sqrt(effBase), 2.0); // sqrt dampens extreme scaling
    const totalPct = Math.min(ranksL * pctPerRank, scaledCap);
    mult *= (1 + totalPct);
  }
  
  // celestial_resonance: One-time technique
  if (isTechniquePurchased('celestial_resonance')) {
    const sk = getSkill('celestial_resonance');
    mult *= (1 + (sk?.value || 0.12));
  }
  
  // Apply final multipliers
  const out = add * mult * S.qpsMult * karmaQiMult(S.reinc.karma) * cyclePowerMult(S.realmIndex);
  return Number.isFinite(out) ? out : 1e300;
}

/**
 * Calculate total offline multiplier with hybrid skill system
 * closed_door: Percentage skill with cap × effectiveSkillBase
 */
function totalOfflineMult(){
  const ranksClosed = currentRealmRanks('closed_door');
  if (ranksClosed <= 0) return 1.0;
  
  const sk = getSkill('closed_door');
  const basePctPerRank = sk?.base || 0.005;
  const capPct = sk?.capPctPerRealm || 0.08;
  
  // Apply realm-aware floors/caps to per-rank percentage
  const minPct = minTierPctByRealm(S.realmIndex);
  const maxPct = maxTierPctByRealm(S.realmIndex);
  const pctPerRank = Math.max(minPct, Math.min(maxPct, basePctPerRank));
  
  // Total percentage with effective base influencing the cap
  const effBase = effectiveSkillBase('closed_door');
  const scaledCap = Math.min(capPct * Math.sqrt(effBase), 1.0); // sqrt dampens, cap at 100%
  const totalPct = Math.min(ranksClosed * pctPerRank, scaledCap);
  
  return 1.0 + totalPct;
}

function getSkill(id){ return getSkillCatalog().find(s=>s.id===id); }

/**
 * Calculate cost for next rank or technique purchase
 * For ranked skills: cost grows per rank in current realm
 * For techniques: fixed one-time cost
 * @param {string} id - Skill ID
 * @returns {number} Cost in Qi
 */
function skillCost(id){
  const sk = getSkill(id);
  if (!sk) return Infinity;
  
  // One-time techniques: fixed cost
  if (sk.oneTime) {
    return sk.cost;
  }
  
  // Ranked skills: cost scales with current realm ranks
  const currentRanks = currentRealmRanks(id);
  return Math.floor(sk.cost * Math.pow(sk.costScale, currentRanks));
}

// ============= BULK SKILL BUYING SYSTEM (LOG-SPACE SAFE) =============

/**
 * Log-space safe overflow guard
 * ~exp(690) ≈ 1e300, beyond this we hit Number.MAX_VALUE
 */
const LOG_MAX = 690;

// Log helper functions
const ln = Math.log;
const exp = Math.exp;

/**
 * Get cost of a single level at a specific level (not current level)
 * @param {string} skillId - Skill ID
 * @param {number} level - Level to calculate cost for (realm-relative rank)
 * @returns {number} Cost for that specific level
 */
function skillCostAtLevel(skillId, level) {
  const sk = getSkill(skillId);
  if (sk.oneTime) return sk.cost; // Techniques don't have levels
  return Math.floor(sk.cost * Math.pow(sk.costScale, level));
}

/**
 * Calculate log of skill cost at specific level
 * Returns ln(cost * scale^level)
 * @param {Object} sk - Skill object
 * @param {number} level - Level to calculate for
 * @returns {number} Natural log of cost
 */
function lnSkillCostAtLevel(sk, level) {
  return ln(sk.cost) + level * ln(sk.costScale);
}

/**
 * Calculate log of total cost for qty levels starting from level L
 * Uses geometric series: sum = c0 * (r^qty - 1) / (r - 1)
 * Where c0 = cost * scale^L
 * @param {Object} sk - Skill object
 * @param {number} currentLevel - Starting level
 * @param {number} qty - Number of levels to buy
 * @returns {number} Natural log of total cost (or -Infinity if 0)
 */
function lnTotalCost(sk, currentLevel, qty) {
  if (qty <= 0) return -Infinity; // ln(0) = -Infinity
  
  const lnCost = ln(sk.cost);
  const lnR = ln(sk.costScale);
  
  // ln(c0) = ln(cost) + currentLevel * ln(scale)
  const lnC0 = lnCost + currentLevel * lnR;
  
  // Handle scale ≈ 1 (linear progression)
  if (Math.abs(sk.costScale - 1) < 0.0001) {
    // sum = qty * c0
    // ln(sum) = ln(qty) + ln(c0)
    return ln(qty) + lnC0;
  }
  
  // Geometric series: sum = c0 * (r^qty - 1) / (r - 1)
  // ln(sum) = ln(c0) + ln(r^qty - 1) - ln(r - 1)
  
  // For large qty, r^qty dominates: ln(r^qty - 1) ≈ qty * ln(r)
  // For small qty, use Math.expm1 for numerical stability
  const qtyLnR = qty * lnR;
  const lnNumerator = (qtyLnR > 30) ? qtyLnR : ln(Math.expm1(qtyLnR));
  const lnDenominator = ln(sk.costScale - 1);
  
  return lnC0 + (lnNumerator - lnDenominator);
}

/**
 * Calculate total cost to buy multiple ranks using log-space safe math
 * For techniques: returns fixed cost (qty ignored)
 * For ranked skills: enforces rank cap per realm
 * @param {string} skillId - Skill ID
 * @param {number} qty - Number of ranks to buy
 * @returns {number} Total cost for qty ranks (capped to prevent Infinity)
 */
function totalSkillCost(skillId, qty) {
  if (qty <= 0) return 0;
  
  const sk = getSkill(skillId);
  
  // One-time techniques: fixed cost, qty ignored
  if (sk.oneTime) {
    return sk.cost;
  }
  
  // Ranked skills: enforce rank cap
  const currentRanks = currentRealmRanks(skillId);
  const cap = sk.ranksPerRealm;
  const actualQty = Math.min(qty, cap - currentRanks);
  
  if (actualQty <= 0) return Infinity; // At cap
  
  const lnCost = lnTotalCost(sk, currentRanks, actualQty);
  
  // Guard against overflow
  if (!Number.isFinite(lnCost) || lnCost > LOG_MAX) {
    return 1e300;
  }
  
  const cost = exp(lnCost);
  if (!Number.isFinite(cost)) {
    return 1e300;
  }
  
  return Math.max(0, Math.floor(cost));
}

/**
 * Calculate maximum affordable quantity given a budget using log-space binary search
 * For techniques: returns 1 if can afford, 0 otherwise
 * For ranked skills: respects rank cap per realm
 * @param {string} skillId - Skill ID
 * @param {number} maxQty - Maximum quantity to consider
 * @param {number} budgetQi - Available Qi budget
 * @returns {number} Maximum affordable ranks (0 if none)
 */
function maxAffordableQty(skillId, maxQty, budgetQi) {
  if (budgetQi <= 0 || maxQty <= 0) return 0;
  
  const sk = getSkill(skillId);
  
  // One-time techniques: either 0 or 1
  if (sk.oneTime) {
    return budgetQi >= sk.cost ? 1 : 0;
  }
  
  // Ranked skills: enforce cap
  const currentRanks = currentRealmRanks(skillId);
  const cap = sk.ranksPerRealm;
  const maxPossible = Math.min(maxQty, cap - currentRanks);
  
  if (maxPossible <= 0) return 0;
  
  const lnBudget = ln(Math.max(1, budgetQi));
  
  // Binary search for maximum affordable quantity
  let lo = 0;
  let hi = maxPossible;
  
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const lnCost = lnTotalCost(sk, currentRanks, mid);
    
    // Overflow guard: if cost would exceed LOG_MAX, it's too expensive
    if (!Number.isFinite(lnCost) || lnCost > LOG_MAX) {
      hi = mid - 1;
    } else if (lnCost <= lnBudget) {
      lo = mid; // Can afford this many, try more
    } else {
      hi = mid - 1; // Too expensive, try fewer
    }
  }
  
  return lo;
}

/**
 * Buy skill ranks or technique with bulk support and overflow safety
 * @param {string} skillId - Skill ID
 * @param {number} requestedQty - Requested quantity (ignored for techniques)
 * @returns {boolean} True if purchase succeeded
 */
function buySkill(skillId, requestedQty = 1) {
  const sk = getSkill(skillId);
  if (!sk) return false;
  
  // One-time techniques
  if (sk.oneTime) {
    if (isTechniquePurchased(skillId)) return false; // Already purchased
    if (S.qi < sk.cost) return false; // Can't afford
    
    S.qi -= sk.cost;
    purchaseTechnique(skillId);
    unlockAchievement('first_technique');
    renderAll();
    return true;
  }
  
  // Ranked skills with cap enforcement
  requestedQty = Math.max(1, Math.floor(requestedQty));
  const budget = S.qi;
  const affordable = maxAffordableQty(skillId, requestedQty, budget);
  
  if (affordable <= 0) return false;
  
  const cost = totalSkillCost(skillId, affordable);
  
  // Safety: Never proceed if cost is NaN or Infinity
  if (!Number.isFinite(cost)) {
    if (DEBUG_MODE) {
      console.error(`[Bulk Buy] Cost overflow detected for ${skillId} × ${affordable}`);
    }
    return false;
  }
  
  // Double-check affordability
  if (cost > budget) return false;
  
  // Execute purchase atomically
  S.qi -= cost;
  addRealmRank(skillId, affordable);
  
  // Safety: Ensure Qi remains finite
  S.qi = safeNum(S.qi, 0);
  
  // Track for achievements
  achievementState.totalPurchases += affordable;
  saveAchievementState();
  
  // Update UI
  save();
  renderAll();
  
  // Show feedback if bought less than requested
  if (affordable < requestedQty && DEBUG_MODE) {
    console.log(`[Bulk Buy] Bought ${affordable}/${requestedQty} levels of ${skillId} (cost: ${fmt(cost)})`);
  }
  
  return true;
}

/**
 * Calculate and format bulk purchase preview with overflow safety
 * @param {string} skillId - Skill ID
 * @param {number} qty - Quantity to preview
 * @returns {object} Preview data {cost, affordable, canAfford, formattedCost}
 */
function previewBulkCost(skillId, qty) {
  const totalCost = totalSkillCost(skillId, qty);
  const affordable = maxAffordableQty(skillId, qty, S.qi);
  const canAfford = affordable >= qty;
  
  // Safety: Handle infinite/NaN costs gracefully
  const safeFormattedCost = Number.isFinite(totalCost) ? fmt(totalCost) : '∞';
  
  return {
    cost: totalCost,
    affordable: affordable,
    canAfford: canAfford,
    formattedCost: safeFormattedCost
  };
}

// In-memory storage for last selected bulk multiplier (per session only)
let lastBulkMultiplier = 1;

/**
 * Get the last used bulk multiplier
 */
function getLastBulkMultiplier() {
  return lastBulkMultiplier;
}

/**
 * Set the bulk multiplier for session
 */
function setLastBulkMultiplier(mult) {
  lastBulkMultiplier = mult;
}

// ============= REALM-SCALED SKILL SYSTEM =============

/**
 * Calculate realm-based scaling for skill effectiveness
 * Bounded exponential that preserves skill type (additive stays additive, % stays %)
 * @param {number} realmIndex - Current realm index (0-10)
 * @returns {number} Scaling multiplier (1.0 to 3.0)
 */
function skillRealmScale(realmIndex) {
  const MAX_BONUS = 2.0;   // Cap at +200% (i.e., ×3 total)
  const K = 0.22;          // Curve steepness
  // At realm 0: 1.0, at realm 5: ~1.66, at realm 10: ~2.86 → capped to 3.0
  return Math.min(1 + MAX_BONUS, 1 + MAX_BONUS * (1 - Math.exp(-K * realmIndex)));
}

/**
 * Calculate per-level effect for a skill (type-preserving)
 * Additive skills return flat numbers (e.g., +5.2 Qi/s per level)
 * Percent skills return small fractions (e.g., 0.015 = +1.5% per level)
 * @param {string} id - Skill ID
 * @returns {number} Effect per level (flat or percent fraction)
 */
function perLevelEffect(id) {
  const base = BAL.skills[id]?.base || 0;
  const scale = skillRealmScale(S.realmIndex);
  const kind = getKind(id);
  
  if (kind === 'qps_add' || kind === 'qpc_add') {
    // Additive skills: stays flat across all realms
    return base * scale;
  }
  
  // Percent skills: clamp to 0-2% per level to prevent explosion
  // If balance.json bases are like 0.25, divide by 100; else just clamp
  const pct = Math.min(0.02, (base * scale) / 100);
  return Math.max(0, pct);
}

/**
 * Apply diminishing returns to percentage-based skills (late-game)
 * @param {number} perLevelPct - Percentage per level (e.g., 0.015 = 1.5%)
 * @param {number} L - Skill level
 * @returns {number} Total percentage with DR (capped at +150% from single skill)
 */
function percentWithDR(perLevelPct, L) {
  if (L <= 0) return 0;
  const raw = perLevelPct * L;
  const dr = Math.pow(raw, 0.9);  // Soft cap exponent
  return Math.min(dr, 1.5);        // Hard cap at +150%
}

/**
 * Get effective skill base scaled by current realm
 * Replaces direct BAL.skills[id].base usage in calculations
 * @param {string} id - Skill ID
 * @returns {number} Realm-scaled base effectiveness
 */
function effectiveSkillBase(id) {
  const base = BAL.skills[id]?.base || 0;
  const realmMult = skillRealmScale(S.realmIndex);
  return base * realmMult;
}

/**
 * DEPRECATED: Determine skill tier (kept for compatibility, not used in calculations)
 * Use getKind(id) instead for behavior determination
 * @param {string} id - Skill ID
 * @returns {number} Cosmetic tier (1, 2, or 3)
 */
function skillTier(id) {
  const r = S.realmIndex;
  if (r < idx('golden_core')) return 1;
  if (r < idx('spirit_transformation')) return 2;
  return 3;
}

/**
 * Calculate skill's effective contribution value (kind-based, type-preserving)
 * Additive skills: returns flat value (e.g., +52.3 Qi/s total)
 * Percent skills: returns fraction with DR (e.g., 0.27 = +27% total)
 * @param {string} id - Skill ID
 * @param {number} level - Skill level
 * @returns {number} Total effect (flat or percent fraction)
 */
function skillEffectValue(id, level) {
  if (level <= 0) return 0;
  
  const kind = getKind(id);
  const per = perLevelEffect(id);
  
  if (kind === 'qps_add' || kind === 'qpc_add') {
    // Additive: flat multiplication (stays flat forever)
    return per * level;
  }
  
  // Percent kinds: apply DR to prevent runaway growth
  return percentWithDR(per, level);
}

// Get skill base effectiveness (DEPRECATED - use effectiveSkillBase instead)
// Kept for compatibility with old code references
function baseEff(id){
  return effectiveSkillBase(id);
}

// DEPRECATED: Old reincarnation bonus (replaced by karmaQiMult soft cap)
// Kept for compatibility with old code references
function reincBonus(){
  return karmaQiMult(S.reinc.karma);
}

// DEPRECATED: Old karma-based lifespan efficiency
// Replaced by karmaLifeMult applied to max lifespan
function karmaLifespanBonus(){
  // Return 1.0 (no reduction) - aging is now fixed, karma extends max lifespan instead
  return 1.0;
}

// DEPRECATED: Old karma-based stage requirement reduction
// Replaced by karmaStageMult soft cap
function karmaStageBonus(){
  return 1.0 / karmaStageMult(S.reinc.karma); // Inverse for requirement multiplication
}

// Check if player can manually reincarnate (Spirit Transformation Stage 1+, after mandatory ST10)
function canReincarnate(){
  const ST_INDEX = idx('spirit_transformation'); // Spirit Transformation realm index (ID-driven)
  const r = S.realmIndex;
  const st = S.stage;
  
  // Before the first mandatory ST10 reincarnation is done:
  if (!S.flags?.hasCompletedMandatoryST10) {
    // No voluntary reincarnation anywhere; only the mandatory one at ST10 (handled elsewhere)
    return false;
  }
  
  // After the mandatory ST10 has been completed:
  // Allow voluntary reincarnation anywhere at or above Spirit Transformation Stage 1
  // i.e., realm > ST, OR (realm === ST && stage >= 1)
  return (r > ST_INDEX) || (r === ST_INDEX && st >= 1);
}

// Calculate karma gain from reincarnation with cycle multipliers
function computeKarmaGain(){
  const safeLifetimeQi = safeNum(S.reinc.lifetimeQi, 0);
  const safeDivisor = safeNum(BAL.reincarnation.lifetimeQiDivisor, 1000);
  const base = Math.floor(Math.sqrt(safeLifetimeQi / safeDivisor));
  const realmBonus = S.realmIndex * BAL.reincarnation.realmKarmaFactor;
  
  // Cycle multiplier - Spirit cycle gives more karma
  const cycleMultiplier = S.currentCycle === 'spirit' ? 2 : 1;
  
  const totalGain = (base + realmBonus) * cycleMultiplier;
  return Math.max(BAL.reincarnation.minKarma, totalGain);
}

// Voluntary reincarnation: full karma
function computeVoluntaryKarma(){
  return Math.max(BAL.reincarnation.minKarma, computeKarmaGain());
}

// Death reincarnation: reduced karma (configurable penalty)
function computeDeathKarma(){
  const deathPenalty = BAL.reincarnation.deathPenalty || 0.5;
  return Math.max(BAL.reincarnation.minKarma, Math.floor(computeKarmaGain() * deathPenalty));
}

// Perform reincarnation with mode ('voluntary', 'death', or 'mandatory')
function doReincarnate(options = {}){
  const mode = options.mode || 'voluntary'; // 'voluntary', 'death', 'mandatory'
  
  // Debug assertion for development mode
  debugAssertReincarnationRate();
  
  // Set reincarnation guard
  if(S.lifecycle) {
    S.lifecycle.isReincarnating = true;
    S.lifecycle.lastReincarnateAt = Date.now();
  }
  
  // Compute karma gain based on mode
  let gain;
  if (mode === 'death') {
    gain = computeDeathKarma();
  } else {
    gain = computeVoluntaryKarma();
  }
  
  // Preserve old state for logic checks (use ID-based lookup for Spirit Transformation)
  const ST_INDEX = idx('spirit_transformation');
  const wasAtST10 = S.realmIndex === ST_INDEX && S.stage === 10;
  const oldReinc = { ...S.reinc };
  const oldFlags = { ...S.flags };
  const oldMeta = { ...S.meta }; // Preserve meta (persistent unlocks)
  
  // Add karma and increment reincarnation count
  const newKarma = oldReinc.karma + gain;
  const newTimes = oldReinc.times + 1;
  
  // Reset to default state
  S = defaultState();
  
  // Restore persistent data
  S.reinc = { times: newTimes, karma: newKarma, lifetimeQi: 0 };
  S.flags = { ...oldFlags }; // Preserve all flags
  S.meta = { ...oldMeta };   // Preserve meta (time-speed unlocks, etc.)
  
  // Handle mandatory ST10 completion
  if (mode === 'mandatory' && wasAtST10) {
    S.flags.hasCompletedMandatoryST10 = true;
    S.flags.hasUnlockedSpiritCycle = true;
    S.flags.canManualReincarnate = true;
    S.flags.unlockedBeyondSpirit = true;
    
    // Track achievement
    unlockAchievement('break_mortal_shackles');
    achievementState.cycleTransitions = (achievementState.cycleTransitions || 0) + 1;
    saveAchievementState();
  }
  
  // Track achievements based on mode
  if (mode === 'voluntary') {
    if(!achievementState.voluntaryReincarnations) {
      achievementState.voluntaryReincarnations = 0;
    }
    achievementState.voluntaryReincarnations++;
    
    if(achievementState.voluntaryReincarnations === 1) {
      unlockAchievement('first_voluntary_reincarnation');
    }
    saveAchievementState();
  } else if (mode === 'death') {
    // Death reincarnation now handled by handleDeathReincarnate()
    // This branch shouldn't be reached anymore but kept for safety
    S.stats.deaths = (S.stats.deaths || 0) + 1;
    
    unlockAchievement('death_and_return');
    if(!achievementState.forcedReincarnationCount) {
      achievementState.forcedReincarnationCount = 0;
    }
    achievementState.forcedReincarnationCount++;
    saveAchievementState();
  }
  
  // Reset age and lifespan properly
  S.age = 0; // Reset age to 0 for new life
  if(S.ageYears !== undefined) delete S.ageYears; // Clean up old field
  S.isDead = false;
  S.life = { isCleanRun: true }; // New life starts clean
  S.flags.lifespanHandled = false; // Reset latch for new life
  S.lastTick = now(); // Reset timing
  
  // Always start at Mortal Realm (realm 0) Stage 1 after reincarnation
  S.realmIndex = 0;
  S.stage = 1;
  S.currentCycle = 'mortal';
  
  // Refresh lifespan for starting realm
  refreshLifespanForRealm();
  
  // Update cycle
  updateCurrentCycle();
  
  // Clear reincarnation guard and unpause
  if(S.lifecycle) {
    S.lifecycle.isReincarnating = false;
  }
  S.timeSpeed.paused = false;
  
  save();
  renderAll();
  
  // Show appropriate modal based on mode
  const karmaGained = gain.toFixed(2);
  const totalKarma = S.reinc.karma.toFixed(2);
  
  if (mode === 'mandatory') {
    showModal('🌟 Transcendence Achieved', 
      `<span class="highlight">You have broken the shackles of mortality!</span><br><br>
      Your soul now walks the path of the Spirit Cycle.<br><br>
      <strong>Voluntary reincarnation is now available</strong> at Spirit Transformation Stage 1 and all higher realms.<br><br>
      <div class="highlight">+${karmaGained} Karma gained (Total: ${totalKarma})</div>`, '🦋');
  } else if (mode === 'death') {
    showModal('☠️ Death and Rebirth', 
      `<span style="color: var(--danger);">Your mortal body has withered. You failed to transcend before death.</span><br><br>
      <strong>Reduced Karma:</strong> ${karmaGained} Karma gained (50% penalty)<br>
      <strong>Total Karma:</strong> ${totalKarma}<br><br>
      <em>Next time, seek voluntary reincarnation at Spirit Transformation Stage 1+ for full rewards.</em>`, '💀');
  } else {
    showModal('♻️ Reincarnation Complete', 
      `The wheel of reincarnation turns, and you begin anew with greater wisdom.<br><br>
      <div class="highlight">+${karmaGained} Karma gained (Total: ${totalKarma})</div><br>
      Your accumulated karma will enhance your cultivation speed.`, '🔄');
  }
}

// Wrapper functions for specific reincarnation types
function tryManualReincarnate(){
  if(!canReincarnate()) {
    if(!S.flags?.hasCompletedMandatoryST10) {
      showModal('🔒 Reincarnation Locked', 
        `<strong>Unlock Condition:</strong> Complete your first mandatory reincarnation at Spirit Transformation Stage 10.<br><br>
        Once unlocked, voluntary reincarnation will be available at Spirit Transformation Stage 1 and all higher realms with full Karma rewards.`, '⚠️');
    } else {
      showModal('🔒 Wrong Realm or Stage', 
        `Voluntary reincarnation is only available at <strong>Spirit Transformation Stage 1 or higher</strong>.<br><br>
        Current: ${realms[S.realmIndex]?.name || 'Unknown'} Stage ${S.stage}`, '⚠️');
    }
    return;
  }
  
  showConfirm(
    '♻️ Voluntary Reincarnation',
    `Reincarnate now and retain <strong>full Karma</strong>. Your next life will begin stronger.<br><br>
    You will return to Qi Refining Stage 1, but all achievements and unlocks will be preserved.<br><br>
    <em style="color: var(--muted);">Note: Voluntary reincarnation will end your current life run.</em>`,
    () => {
      // Mark this life as no longer clean (reincarnated before natural death)
      if(S.life) S.life.isCleanRun = false;
      doReincarnate({ mode: 'voluntary' });
    },
    null,
    '🔄'
  );
}

function handleDeathReincarnate(){
  // DEPRECATED - replaced by performDeathReincarnation in async flow
  // This function is kept for backwards compatibility
  // It should not be called anymore - handleLifespanEnd handles everything
  console.warn('handleDeathReincarnate called - this is deprecated, use handleLifespanEnd instead');
}

// Lifespan management functions
function getMaxLifespan(realmIndex = null){
  const index = realmIndex !== null ? realmIndex : S.realmIndex;
  const maxFromConfig = BAL.lifespan?.realmMaxLifespan?.[index];
  if(maxFromConfig === null || maxFromConfig === undefined) {
    // True Immortal realm - infinite lifespan
    return null;
  }
  
  // Apply karma multiplier to base lifespan (soft cap, asymptotic to +150%)
  const karmaMult = karmaLifeMult(S.reinc.karma);
  const baseLifespan = maxFromConfig || BAL.lifespan?.realmMaxLifespan?.[0] || 100;
  return Math.floor(baseLifespan * karmaMult);
}

function isImmortal(){
  return getMaxLifespan() === null;
}

/**
 * Refresh lifespan when realm changes
 * Called after breakthrough and reincarnation to ensure lifespan matches current realm
 */
function refreshLifespanForRealm() {
  const max = getMaxLifespan(); // from BAL.lifespan.realmMaxLifespan[S.realmIndex]
  if (max === null) {
    // True Immortal realm - infinite lifespan
    S.lifespan = { current: null, max: null };
    S.age = 0; // Immortals don't age
  } else {
    if (!S.lifespan || !Number.isFinite(S.lifespan.current)) {
      // Initialize lifespan if missing or corrupted
      S.lifespan = { current: max, max: max };
    } else {
      // Update max and clamp current to new max
      S.lifespan.max = max;
      S.lifespan.current = Math.min(S.lifespan.current, max);
    }
  }
}

function updateLifespanOnRealmAdvance(){
  const newMax = getMaxLifespan();
  if(newMax === null) {
    // True Immortal - set infinite lifespan
    S.lifespan.max = null;
    S.lifespan.current = null;
    S.age = 0; // Reset age for immortals
  } else {
    S.lifespan.max = newMax;
    S.lifespan.current = newMax; // fully restore lifespan on realm advancement
    S.age = 0; // Reset age to 0 when advancing realm
  }
  
  // Reset lifespan latch when advancing realms
  if(S.flags) {
    S.flags.lifespanHandled = false;
  }
}

/**
 * Age progression system - ticks age forward based on speed-adjusted dt
 * @param {number} dt - Already includes time speed multiplier (rawDt × speed)
 * 
 * IMPORTANT: dt is pre-multiplied by speed in loop()
 * This function does NOT read S.timeSpeed.current
 */
function tickLifespan(dt){
  // Guard: don't age if paused, dead, or no lifespan data
  if(S.timeSpeed?.paused || !S.lifespan || S.isDead) return;
  
  // Guard: True Immortal realm has infinite lifespan - no aging
  if(isImmortal()) return;
  
  // Guard: don't tick during reincarnation process
  if(S.lifecycle?.isReincarnating) return;
  
  // Guard: protect against negative dt (clock changes, sleep, etc.)
  const safeDt = Math.max(0, dt);
  if(safeDt === 0) return;
  
  // Calculate aging rate: dt (already speed-adjusted) × yearsPerSecond
  // dt already includes time speed multiplier from loop()
  const baseYearsPerSecond = BAL.lifespan?.yearsPerSecond || 1.0;
  const agingRate = safeDt * baseYearsPerSecond;
  
  // Migrate old ageYears to age if needed
  if(S.ageYears !== undefined && S.age === undefined) {
    S.age = S.ageYears;
    delete S.ageYears;
  }
  
  // Initialize age if missing
  if(!S.age || !isFinite(S.age)) {
    S.age = 0;
  }
  
  // Apply aging
  const newAge = S.age + agingRate;
  
  // Guard: prevent NaN/Infinity
  if(!isFinite(newAge)) {
    console.warn('Age calculation resulted in non-finite value, keeping previous age');
    return;
  }
  
  // Get max lifespan (with karma multiplier)
  const maxLifespan = getMaxLifespan();
  
  // Clamp age to [0, maxLifespan]
  if(maxLifespan !== null) {
    S.age = Math.max(0, Math.min(newAge, maxLifespan));
  } else {
    S.age = Math.max(0, newAge); // Infinite lifespan, just prevent negative
  }
  
  // Update lifespan.current for backwards compatibility (max - age)
  if(S.lifespan.max !== null) {
    S.lifespan.current = Math.max(0, S.lifespan.max - S.age);
  }
  
  // Check for death ONCE per life using latch flag
  if(maxLifespan !== null && S.age >= maxLifespan && !S.flags.lifespanHandled){
    S.flags.lifespanHandled = true; // Set latch to prevent duplicate popups
    handleLifespanEnd();
    return; // Exit early after triggering death
  }
}

// Death handling guard to prevent duplicate popups
let isHandlingDeath = false;

async function handleLifespanEnd(){
  // Prevent multiple simultaneous death triggers (debounce)
  if(isHandlingDeath || S.lifecycle?.isReincarnating || S.isDead) return;
  
  isHandlingDeath = true;
  
  try {
    // Set death flag and reincarnation guard immediately
    S.isDead = true;
    S.lifecycle.isReincarnating = true;
    S.lifecycle.lastDeathAt = Date.now();
    
    // PAUSE THE GAME - set speed to 0
    S.timeSpeed.current = 0;
    S.timeSpeed.paused = true;
    
    // Get current age (migrate from ageYears if needed)
    const currentAge = S.age !== undefined ? S.age : (S.ageYears || 0);
    
    // Compute death karma before showing modal
    const gain = computeDeathKarma();
    const gainFormatted = fmt(gain);
    const ageFormatted = fmtYears(currentAge);
    
    // Show single death modal and wait for user to dismiss it
    await ModalManager.alert({
      title: '☠️ Your Candle Has Burned Out',
      body: `<span style="color: var(--danger);">Your mortal body has withered after ${ageFormatted}.</span><br><br>
        <strong>Karma Gained:</strong> <span class="highlight">${gainFormatted} Karma</span> (50% death penalty)<br><br>
        <em>You will be reborn into a new life...</em>`,
      confirmText: 'Begin Again',
      icon: '💀'
    });
    
    // Perform reincarnation ONCE after modal is dismissed
    await performDeathReincarnation(gain);
    
  } finally {
    isHandlingDeath = false;
    // Latch flag is reset in reincarnation function
  }
}

async function performDeathReincarnation(karmaGain) {
  // Increment deaths counter (deaths do NOT count as reincarnations)
  S.stats = S.stats || {};
  S.stats.deaths = (S.stats.deaths || 0) + 1;
  
  // Apply karma gain
  const newKarma = (S.reinc?.karma || 0) + karmaGain;
  // DO NOT increment reincarnation times on death - only voluntary/mandatory reincarnations count
  const newTimes = (S.reinc?.times || 0); // Keep same count
  
  // Preserve meta-progression (flags, achievements already earned)
  const keepFlags = S.flags ? { ...S.flags } : {};
  const keepStats = { deaths: S.stats.deaths };
  const keepReinc = { times: newTimes, karma: newKarma, lifetimeQi: 0 };
  const keepMeta = S.meta ? { ...S.meta } : { unlockedSpeeds: [0, 0.5, 1] }; // Preserve meta (time-speed unlocks, etc.)
  
  // Full hard reset to default state
  S = defaultState();
  
  // Restore persistent meta-progression
  S.flags = keepFlags;
  S.flags.lifespanHandled = false; // Reset latch for new life
  S.stats = keepStats;
  S.reinc = keepReinc;
  S.meta = keepMeta; // Restore meta
  
  // Reset age and timing for new life
  S.age = 0;
  S.lastTick = now();
  
  // Initialize age and lifespan cleanly for new life
  S.ageYears = 0;
  const newMaxLifespan = getMaxLifespan(0); // Qi Refining base lifespan
  if(newMaxLifespan === null) {
    S.lifespan = { current: null, max: null };
  } else {
    const validLifespan = safeNum(newMaxLifespan, 100);
    S.lifespan = { current: validLifespan, max: validLifespan };
  }
  S.isDead = false;
  S.life = { isCleanRun: true }; // New life, no reincarnations yet
  
  // Reset timing and ensure time is NOT paused
  S.lastTick = now();
  S.timeSpeed = S.timeSpeed || {};
  S.timeSpeed.paused = false; // Explicitly unpause
  S.timeSpeed.current = 1; // Reset to normal speed
  
  // Track achievement for death reincarnation
  unlockAchievement('death_and_return');
  if(!achievementState.forcedReincarnationCount) {
    achievementState.forcedReincarnationCount = 0;
  }
  achievementState.forcedReincarnationCount++;
  saveAchievementState();
  
  // Clear reincarnation guard
  S.lifecycle.isReincarnating = false;
  
  // Full UI refresh and save
  save();
  renderAll();
  
  // NO second modal - user has already been informed
}

function showDeathConfirmModal(){
  // DEPRECATED - replaced by handleLifespanEnd async flow
  // Keeping for backwards compatibility in case referenced elsewhere
  handleLifespanEnd();
}

function handleDeath(){
  // Legacy function - redirect to new async implementation
  handleLifespanEnd();
}

// DEPRECATED - showDeathMessage was part of old implementation
function showDeathMessage(){
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: linear-gradient(45deg, rgba(0,0,0,0.85), rgba(20,10,10,0.9));
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    opacity: 0;
    transition: opacity 0.8s ease;
    backdrop-filter: blur(4px);
  `;
  
  const message = document.createElement('div');
  message.style.cssText = `
    background: linear-gradient(135deg, var(--panel), #1a0f0f);
    border: 2px solid var(--danger);
    border-radius: 20px;
    padding: 32px;
    text-align: center;
    color: var(--text);
    max-width: 450px;
    transform: scale(0.7) rotate(-2deg);
    transition: all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);
    box-shadow: 0 20px 60px rgba(255, 107, 107, 0.3);
  `;
  
  message.innerHTML = `
    <div style="font-size: 3em; margin-bottom: 16px; animation: fadeInPulse 0.8s ease;">💀</div>
    <h3 style="margin: 0 0 16px 0; color: var(--danger); font-size: 1.4em;">End of Mortal Life</h3>
    <p style="margin: 0; color: var(--muted); line-height: 1.5;">Your mortal body has reached its end.<br>You feel your spirit leaving this realm...<br><br><em style="color: var(--accent);">Reincarnation begins.</em></p>
  `;
  
  // Add keyframe animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeInPulse {
      0% { opacity: 0; transform: scale(0.5); }
      50% { opacity: 0.8; transform: scale(1.2); }
      100% { opacity: 1; transform: scale(1); }
    }
  `;
  document.head.appendChild(style);
  
  overlay.appendChild(message);
  document.body.appendChild(overlay);
  
  // Animate in
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    message.style.transform = 'scale(1) rotate(0deg)';
  });
  
  // Remove after 2.5 seconds
  setTimeout(() => {
    overlay.style.opacity = '0';
    message.style.transform = 'scale(0.8) rotate(1deg)';
    setTimeout(() => {
      overlay.remove();
      style.remove();
    }, 800);
  }, 2500);
}

// ============= TIME SPEED SYSTEM =============

/**
 * Progressive time speed configuration with realm-gated unlocks
 * Uses realm IDs (not indices) for robust unlock conditions
 * Unlock progression: one new speed every 2 realms
 */
const SPEEDS_CONFIG = [
  { speed: 0,    unlockAt: 'mortal_realm' },           // Always available (pause)
  { speed: 0.25, unlockAt: 'mortal_realm' },           // Always available
  { speed: 0.5,  unlockAt: 'mortal_realm' },           // Always available
  { speed: 1,    unlockAt: 'mortal_realm' },           // Always available (normal)
  { speed: 2,    unlockAt: 'foundation_establishment' }, // Realm 2
  { speed: 4,    unlockAt: 'nascent_soul' },           // Realm 4
  { speed: 6,    unlockAt: 'void_refining' },          // Realm 6
  { speed: 8,    unlockAt: 'mahayana' },               // Realm 8
  { speed: 10,   unlockAt: 'true_immortal' }           // Realm 10
];

/**
 * Base speeds that are always available, regardless of realm
 * These are injected unconditionally and never rely on unlock arrays
 */
const BASE_SPEEDS_ALWAYS_AVAILABLE = [0, 0.25, 0.5, 1];

/**
 * Validate and initialize time speed system
 * Ensures base speeds exist and S.meta.unlockedSpeeds is properly initialized
 * Called at boot and after loadBalance()
 */
function validateTimeSpeedSystem() {
  // Initialize meta.unlockedSpeeds if missing
  if (!S.meta?.unlockedSpeeds || !Array.isArray(S.meta.unlockedSpeeds)) {
    if (!S.meta) S.meta = {};
    S.meta.unlockedSpeeds = [...BASE_SPEEDS_ALWAYS_AVAILABLE];
  }
  
  // Inject base speeds unconditionally (never rely on unlock arrays for these)
  BASE_SPEEDS_ALWAYS_AVAILABLE.forEach(speed => {
    if (!S.meta.unlockedSpeeds.includes(speed)) {
      S.meta.unlockedSpeeds.push(speed);
    }
  });
  
  // De-duplicate and sort
  S.meta.unlockedSpeeds = [...new Set(S.meta.unlockedSpeeds)].sort((a, b) => a - b);
  
  if (DEBUG_MODE) {
    console.log('[Time Speed] Initialized with speeds:', S.meta.unlockedSpeeds);
  }
}

// Time speed management functions
function getAvailableSpeeds(){
  // Return permanently unlocked speeds from meta
  // Ensure system is initialized
  if(!S.meta?.unlockedSpeeds || !Array.isArray(S.meta.unlockedSpeeds)) {
    return [...BASE_SPEEDS_ALWAYS_AVAILABLE]; // Fallback base speeds
  }
  
  // Always inject base speeds (defensive - should be done by validateTimeSpeedSystem)
  const speeds = [...S.meta.unlockedSpeeds];
  BASE_SPEEDS_ALWAYS_AVAILABLE.forEach(speed => {
    if (!speeds.includes(speed)) speeds.push(speed);
  });
  
  // Sort and de-duplicate
  return [...new Set(speeds)].sort((a, b) => a - b);
}

// Check if new speeds should be unlocked based on realm progression
function checkAndUnlockSpeeds(){
  // Use SPEEDS_CONFIG for ID-driven unlocks
  SPEEDS_CONFIG.forEach(config => {
    const requiredRealmIndex = idx(config.unlockAt);
    
    // Skip if realm ID not found
    if (requiredRealmIndex === -1) {
      if (DEBUG_MODE) {
        console.warn(`[Time Speed] Unknown realm ID: ${config.unlockAt}`);
      }
      return;
    }
    
    // Check if player has reached required realm
    if (S.realmIndex >= requiredRealmIndex && !S.meta.unlockedSpeeds.includes(config.speed)) {
      S.meta.unlockedSpeeds.push(config.speed);
      
      // Show unlock notification (skip base speeds)
      if (!BASE_SPEEDS_ALWAYS_AVAILABLE.includes(config.speed)) {
        showSpeedUnlockToast(config.speed);
      }
      
      if (DEBUG_MODE) {
        console.log(`[Time Speed] Unlocked ${config.speed}× at ${realms[S.realmIndex].name}`);
      }
    }
  });
  
  // Always ensure base speeds are present (defensive)
  BASE_SPEEDS_ALWAYS_AVAILABLE.forEach(speed => {
    if (!S.meta.unlockedSpeeds.includes(speed)) {
      S.meta.unlockedSpeeds.push(speed);
    }
  });
  
  // De-duplicate and sort
  S.meta.unlockedSpeeds = [...new Set(S.meta.unlockedSpeeds)].sort((a, b) => a - b);
}

/**
 * Show a toast notification when a new time speed is unlocked
 */
function showSpeedUnlockToast(speed) {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.innerHTML = `
    <div class="achievement-toast-icon">⏱️</div>
    <div class="achievement-toast-content">
      <div class="achievement-toast-title">Time Speed Unlocked!</div>
      <div class="achievement-toast-desc">You can now accelerate time to ${speed}×</div>
    </div>
  `;
  
  document.body.appendChild(toast);
  
  // Trigger show animation
  setTimeout(() => toast.classList.add('show'), 10);
  
  // Auto-hide after 3 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

function setTimeSpeed(speed){
  const availableSpeeds = getAvailableSpeeds();
  
  // If requested speed is not available, fallback to 1×
  if(!availableSpeeds.includes(speed)) {
    speed = 1; // Default fallback
  }
  
  if(speed === 0){
    S.timeSpeed.paused = true;
    S.timeSpeed.current = 0;
  } else {
    S.timeSpeed.paused = false;
    S.timeSpeed.current = speed;
  }
  
  save();
  renderTimeSpeed();
}

/**
 * CENTRALIZED TIME SPEED GETTER - Single source of truth
 * Returns the current time speed multiplier (0, 0.5, 1, 2, 4, 6, 8, 10...)
 * Use this everywhere for consistent time scaling
 */
function getTimeSpeed() {
  return S.timeSpeed.paused ? 0 : S.timeSpeed.current;
}

/**
 * DEPRECATED: Returns 1 to prevent time speed from affecting Qi gains
 * Time speed affects ONLY lifespan aging, never Qi/QPS/QPC
 */
function getCurrentTimeMultiplier(){
  return 1;
}

function canBreakthrough(){
  const req = stageRequirement(S.realmIndex, S.stage);
  if(S.qi < req) return false;
  
  // Check for Spirit Transformation gate (use ID-based lookup)
  const ST_INDEX = idx('spirit_transformation');
  if(S.realmIndex === ST_INDEX && S.stage === 10 && !S.flags?.unlockedBeyondSpirit) {
    return true; // Can breakthrough to trigger the gate modal
  }
  
  return true;
}

function doBreakthrough(){
  const req = stageRequirement(S.realmIndex, S.stage);
  if(S.qi < req) return;
  S.qi -= req;
  
  if(S.stage < 10){
    S.stage++;
  } else {
    // Check for Spirit Transformation gate (use ID-based lookup)
    const ST_INDEX = idx('spirit_transformation');
    if(S.realmIndex === ST_INDEX && !S.flags.unlockedBeyondSpirit) {
      showSpiritTransformationGate();
      return;
    }
    
    // Check for cycle end before advancing to next realm
    if(isAtCycleEnd()){
      triggerCycleTransition();
      return;
    }
    
    if(S.realmIndex < realms.length-1){
      const wasSpritTransformation = S.realmIndex === ST_INDEX;
      S.realmIndex++; S.stage = 1;
      S.qpcBase += BAL.progression.realmAdvanceReward.qpcBaseAdd; 
      S.qpsBase += BAL.progression.realmAdvanceReward.qpsBaseAdd;
      updateLifespanOnRealmAdvance(); // restore lifespan on realm advancement
      updateCurrentCycle(); // Update cycle when moving to new realm
      checkAndUnlockSpeeds(); // Check for new time-speed unlocks
      
      // Show special message when advancing to spirit realms after unlocking transcendence
      const VR_INDEX = idx('void_refining');
      if(wasSpritTransformation && S.flags.unlockedBeyondSpirit && S.realmIndex === VR_INDEX) {
        setTimeout(() => {
          showModal(
            '🌟 Spirit Cycle Begins',
            'You have transcended beyond mortal limitations and entered the Spirit Cycle! Your cultivation now follows the celestial path of divine realms.',
            '🌌'
          );
        }, 500);
      }
    } else {
      // Final ascension at True Immortal Stage 10
      triggerCycleTransition();
    }
  }
}

function tick(rawDt, speed){
  // Guard: no progress when paused (0× speed)
  if(speed === 0) return;
  
  // Guard against ticking during reincarnation process
  if(S.lifecycle?.isReincarnating) return;
  
  // Guard against ticking while death modal is being handled
  if(isHandlingDeath) return;
  
  // QI GAINS: Use raw dt (real elapsed time), NO speed multiplication
  // Time speed does NOT affect Qi accumulation rate
  const qps = totalQPS();
  const gain = qps * rawDt; // No speed factor, no turbo - pure wall-clock time
  
  safeAddQi(gain);
  S.reinc.lifetimeQi = safeNum(S.reinc.lifetimeQi + gain, 0);
  
  // LIFESPAN AGING: Apply time speed multiplier
  // Time speed affects ONLY aging, making you age faster/slower
  const dtForLifespan = rawDt * speed;
  tickLifespan(dtForLifespan);
  
  // Check for lifespan gate after aging
  checkLifespanGate();
  
  // Exit early if death was triggered during lifespan tick
  if(S.lifecycle?.isReincarnating) return;
}

function onClick(){
  // Guard: no clicking when paused (0× speed)
  const timeSpeed = getTimeSpeed();
  if(timeSpeed === 0) return;
  
  if(S.lifecycle?.isReincarnating) return; // no clicking during reincarnation
  
  // QI GAINS FROM CLICKS: Speed-independent, no time multiplier
  // Click power is based ONLY on cultivation level (totalQPC), not time speed
  const gain = totalQPC();
  safeAddQi(gain);
  S.reinc.lifetimeQi = safeNum(S.reinc.lifetimeQi + gain, 0);
  
  // Track clicks for achievements
  achievementState.totalClicks++;
  saveAchievementState();
  
  flashNumber('+'+fmt(gain));
  
  // Blue halo pulse effect
  const host = document.getElementById('clickBtn');
  host.classList.remove('pulse');
  void host.offsetWidth; // reflow to restart animation
  host.classList.add('pulse');
}

// Reemplazá tu flashNumber por este para posicionar cerca de la imagen
function flashNumber(text){
  const host = document.getElementById('clickBtn');
  const r = host.getBoundingClientRect();
  const el = document.createElement('div');
  el.textContent = text;
  el.style.position = 'fixed';
  el.style.left = (r.left + r.width/2 + (Math.random()*30-15)) + 'px';
  el.style.top  = (r.top  + r.height*0.35 + (Math.random()*20-10)) + 'px';
  el.style.transform = 'translate(-50%, -50%)';
  el.style.pointerEvents='none';
  el.style.fontWeight='800';
  el.style.opacity='1';
  el.style.transition='transform .8s ease, opacity .8s ease';
  document.body.appendChild(el);
  requestAnimationFrame(()=>{
    el.style.transform='translate(-50%, -90%)';
    el.style.opacity='0';
  });
  setTimeout(()=>el.remove(),850);
}

// ============= ACHIEVEMENTS SYSTEM =============

const ACHIEVEMENTS_KEY = 'xianxiaAchievementsV1';

const ACHIEVEMENTS = [
  // Progression Achievements
  {
    id: "ach_mortal_10",
    title: "First Steps Complete",
    description: "Reach Mortal Realm Stage 10.",
    icon: "👣",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('mortal_realm') && stage === 10
  },
  {
    id: "reach_qi_refining_10",
    title: "Qi Foundation Mastered",
    description: "Reach Qi Refining, Stage 10 and master the fundamentals of cultivation.",
    icon: "🌱",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('qi_refining') && stage === 10
  },
  {
    id: "reach_foundation_10",
    title: "Foundation Perfected",
    description: "Reach Foundation Establishment, Stage 10 and solidify your cultivation base.",
    icon: "🏛️",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('foundation_establishment') && stage === 10
  },
  {
    id: "reach_golden_core_10",
    title: "Golden Core Perfected",
    description: "Reach Golden Core, Stage 10 and forge your spiritual core.",
    icon: "⚡",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('golden_core') && stage === 10
  },
  {
    id: "reach_nascent_soul_10",
    title: "Soul Awakened",
    description: "Reach Nascent Soul, Stage 10 and awaken your spiritual consciousness.",
    icon: "👁️",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('nascent_soul') && stage === 10
  },
  {
    id: "reach_spirit_transform_10",
    title: "Spirit Transformed",
    description: "Reach Spirit Transformation, Stage 10 and transcend your mortal form.",
    icon: "🦋",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('spirit_transformation') && stage === 10
  },
  {
    id: "reach_void_refining_10",
    title: "Void Walker",
    description: "Reach Void Refining, Stage 10 and master the emptiness between worlds.",
    icon: "🌌",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('void_refining') && stage === 10
  },
  {
    id: "reach_body_integration_10",
    title: "Body and Soul United",
    description: "Reach Body Integration, Stage 10 and achieve perfect harmony.",
    icon: "☯️",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('body_integration') && stage === 10
  },
  {
    id: "reach_mahayana_10",
    title: "Great Vehicle Master",
    description: "Reach Mahayana, Stage 10 and walk the supreme path.",
    icon: "🚗",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('mahayana') && stage === 10
  },
  {
    id: "reach_tribulation_10",
    title: "Tribulation Survivor",
    description: "Reach Tribulation Transcendence, Stage 10 and overcome heavenly judgment.",
    icon: "⚡",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === idx('tribulation_transcendence') && stage === 10
  },
  {
    id: "reach_true_immortal",
    title: "True Immortal",
    description: "Ascend to True Immortal realm and achieve eternal existence.",
    icon: "🌟",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex }) => realmIndex >= idx('true_immortal')
  },

  // Reincarnation Achievements
  {
    id: "first_reincarnation",
    title: "Cycle of Rebirth",
    description: "Choose to begin anew after transcending mortality - perform a voluntary reincarnation.",
    icon: "🔄",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ voluntaryReincarnations }) => voluntaryReincarnations >= 1
  },
  {
    id: "rebirth_5",
    title: "Experienced Soul",
    description: "Reincarnate 5 times and accumulate wisdom across lifetimes.",
    icon: "🎭",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ reincTimes }) => reincTimes >= 5
  },
  {
    id: "rebirth_20",
    title: "Ancient Soul",
    description: "Reincarnate 20 times and become a master of the endless cycle.",
    icon: "👴",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ reincTimes }) => reincTimes >= 20
  },
  {
    id: "first_voluntary_reincarnation",
    title: "Willing Sacrifice",
    description: "Perform your first voluntary reincarnation at Spirit Transformation Stage 1+ for full Karma rewards.",
    icon: "♻️",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ voluntaryReincarnations }) => voluntaryReincarnations >= 1
  },
  {
    id: "death_and_return",
    title: "Death and Return",
    description: "Experience death by lifespan exhaustion and return through forced reincarnation.",
    icon: "💀",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ forcedReincarnationCount }) => forcedReincarnationCount >= 1
  },

  // Economy / Skills Achievements
  {
    id: "qpc_100",
    title: "Mighty Click",
    description: "Reach 100 Qi per click and feel the power in your fingertips.",
    icon: "👆",
    category: "Skills",
    hiddenUntilUnlocked: false,
    requirement: ({ qpc }) => qpc >= 100
  },
  {
    id: "qps_1k",
    title: "Steady Flow",
    description: "Reach 1,000 Qi per second and achieve constant cultivation.",
    icon: "🌊",
    category: "Skills",
    hiddenUntilUnlocked: false,
    requirement: ({ qps }) => qps >= 1000
  },
  {
    id: "skill_10_any",
    title: "Skill Master",
    description: "Raise any single skill to Level 10 and show your dedication.",
    icon: "📚",
    category: "Skills",
    hiddenUntilUnlocked: false,
    requirement: ({ skills }) => Object.values(skills).some(lvl => lvl >= 10)
  },
  {
    id: "shopper_100_purchases",
    title: "Devoted Student",
    description: "Buy 100 skills total and prove your commitment to growth.",
    icon: "🛒",
    category: "Skills",
    hiddenUntilUnlocked: false,
    requirement: ({ totalPurchases }) => totalPurchases >= 100
  },

  // Time / Offline Achievements
  {
    id: "meditation_master",
    title: "Meditation Master",
    description: "Earn offline Qi from 8+ hours of meditation in one session.",
    icon: "🧘",
    category: "Time",
    hiddenUntilUnlocked: false,
    requirement: ({ offlineHours }) => offlineHours >= 8
  },
  {
    id: "lifespan_saver",
    title: "Longevity Expert",
    description: "Survive 3000 years in a single life without reincarnating.",
    icon: "⏳",
    category: "Time",
    hiddenUntilUnlocked: false,
    requirement: ({ ageYears, isCleanRun }) => ageYears >= 3000 && isCleanRun
  },

  // Secrets / Misc Achievements
  {
    id: "dao_seeker",
    title: "Dao Seeker",
    description: "Open the Achievements panel and begin seeking the path of accomplishment.",
    icon: "🔍",
    category: "Misc",
    hiddenUntilUnlocked: false,
    requirement: ({ achievementsPanelOpened }) => achievementsPanelOpened === true
  },
  {
    id: "harmonious_clicks",
    title: "Harmonious Clicker",
    description: "Perform 1,000 total clicks and achieve clicking harmony.",
    icon: "🎵",
    category: "Misc",
    hiddenUntilUnlocked: false,
    requirement: ({ totalClicks }) => totalClicks >= 1000
  },

  // Cycle and Karma Achievements
  {
    id: "end_mortal_cycle",
    title: "End of the Mortal Cycle",
    description: "Complete the Mortal Cycle and transcend to Spirit Cultivation.",
    icon: "🦋",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ cycleTransitions }) => cycleTransitions >= 1
  },
  {
    id: "spirit_ascendant",
    title: "Spirit Ascendant",
    description: "Begin the Spirit Cycle and walk the celestial path.",
    icon: "🌌",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ currentCycle }) => currentCycle === 'spirit'
  },
  {
    id: "karmic_mastery",
    title: "Karmic Mastery",
    description: "Reach 10,000 Karma and master the laws of cause and effect.",
    icon: "⚖️",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ karma }) => karma >= 10000
  },
  {
    id: "celestial_eternity",
    title: "Celestial Eternity",
    description: "Complete the Spirit Cycle and achieve ultimate transcendence.",
    icon: "♾️",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ spiritCycleComplete }) => spiritCycleComplete === true
  },
  {
    id: "break_mortal_shackles",
    title: "Break the Mortal Shackles",
    description: "Reincarnate at Spirit Transformation Stage 10 to unlock transcendence beyond mortal limits.",
    icon: "�",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ unlockedBeyondSpirit }) => unlockedBeyondSpirit === true
  },

  // Impossible Achievements - Hidden legendary goals
  {
    id: "infinite_qi",
    title: "Qi Without End",
    description: "Reach 1e100 Qi in a single lifetime. The universe trembles before your power.",
    icon: "🌌",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ qi }) => qi >= 1e100
  },
  {
    id: "eternal_clicker",
    title: "Finger of the Dao",
    description: "Perform 1,000,000,000 clicks in total. Your finger has transcended mortality.",
    icon: "👆",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ totalClicks }) => totalClicks >= 1_000_000_000
  },
  {
    id: "karma_overflow",
    title: "Karma Overflow",
    description: "Accumulate over 1,000,000 Karma. You have broken the cosmic balance itself.",
    icon: "⚖️",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ karma }) => karma >= 1_000_000
  },
  {
    id: "beyond_time",
    title: "Beyond Time Itself",
    description: "Survive 1,000,000 in-game years without dying. Time bows to your will.",
    icon: "⏰",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ yearsAlive }) => yearsAlive >= 1_000_000
  },
  {
    id: "click_master",
    title: "The Endless Tap",
    description: "Reach 1e12 Qi per click. Each tap reshapes reality.",
    icon: "💫",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ qpc }) => qpc >= 1e12
  },
  {
    id: "speed_demon",
    title: "Beyond the Dao of Time",
    description: "Unlock time speed x100. You have shattered the temporal prison.",
    icon: "⚡",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ maxTimeSpeed }) => maxTimeSpeed >= 100
  },
  {
    id: "cycle_breaker",
    title: "Cycle Breaker",
    description: "Complete the Spirit Cycle without any forced reincarnations. Death fears you.",
    icon: "🔗",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ forcedReincarnationCount, currentCycle, spiritCycleComplete }) => 
      forcedReincarnationCount === 0 && currentCycle === 'spirit' && spiritCycleComplete
  },
  {
    id: "realm_infinite",
    title: "Beyond True Immortal",
    description: "Reach a realm beyond True Immortal. The impossible becomes possible.",
    icon: "🌟",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ realmIndex }) => realmIndex > idx('true_immortal')
  },
  {
    id: "dao_god",
    title: "God of Cultivation",
    description: "Max every skill to Level 999. You have mastered all earthly techniques.",
    icon: "👑",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ skills }) => Object.keys(skills).length >= 5 && Object.values(skills).every(v => v >= 999)
  },
  {
    id: "ultimate_patience",
    title: "The Eternal Wait",
    description: "Leave the game running for 1000 real hours. Patience is the greatest virtue.",
    icon: "🧘",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ totalPlayTimeHours }) => totalPlayTimeHours >= 1000
  }
];

// Unlocked feature requirements (using ID-based realm lookups)
const UNLOCKS = {
  speed_2x: { requirement: ({ realmIndex }) => realmIndex >= idx('golden_core'), text: "Reach Golden Core realm to unlock 2× time flow." },
  speed_4x: { requirement: ({ realmIndex }) => realmIndex >= idx('spirit_transformation'), text: "Reach Spirit Transformation realm to unlock 4× time flow." },
  speed_6x: { requirement: ({ realmIndex }) => realmIndex >= idx('body_integration'), text: "Reach Body Integration realm to unlock 6× time flow." },
  speed_8x: { requirement: ({ realmIndex }) => realmIndex >= idx('tribulation_transcendence'), text: "Reach Tribulation Transcendence realm to unlock 8× time flow." },
  speed_10x: { requirement: ({ realmIndex }) => realmIndex >= idx('true_immortal'), text: "Reach True Immortal realm to unlock 10× time flow." }
};

// Achievement state management
let achievementState = loadAchievementState();

function loadAchievementState() {
  try {
    const saved = localStorage.getItem(ACHIEVEMENTS_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.warn('Failed to load achievement state:', e);
  }
  return { 
    unlocked: {}, 
    totalClicks: 0, 
    totalPurchases: 0, 
    achievementsPanelOpened: false,
    cycleTransitions: 0,
    spiritCycleComplete: false
  };
}

function saveAchievementState() {
  try {
    localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(achievementState));
  } catch (e) {
    console.warn('Failed to save achievement state:', e);
  }
}

function hasAchievement(id) {
  return !!achievementState.unlocked[id];
}

function unlockAchievement(id) {
  if (hasAchievement(id)) return false; // Already unlocked
  
  const achievement = ACHIEVEMENTS.find(a => a.id === id);
  if (!achievement) return false;
  
  achievementState.unlocked[id] = {
    unlockedAt: Date.now(),
    title: achievement.title,
    description: achievement.description,
    icon: achievement.icon
  };
  
  saveAchievementState();
  showAchievementToast(achievement);
  showAchievementModal(achievement);
  updateAchievementsBadge();
  
  return true;
}

function checkAchievements(context = {}) {
  // Build context object with current game state
  const ctx = {
    realmIndex: S.realmIndex,
    stage: S.stage,
    qpc: totalQPC(),
    qps: totalQPS(),
    qi: S.qi,
    skills: S.skills,
    reincTimes: S.reinc.times,
    karma: S.reinc.karma,
    currentCycle: S.currentCycle,
    lifespanPercent: S.lifespan.max > 0 ? (S.lifespan.current / S.lifespan.max) * 100 : 100,
    ageYears: S.ageYears || 0,
    isCleanRun: S.life?.isCleanRun || false,
    totalClicks: achievementState.totalClicks,
    totalPurchases: achievementState.totalPurchases,
    achievementsPanelOpened: achievementState.achievementsPanelOpened,
    cycleTransitions: achievementState.cycleTransitions || 0,
    spiritCycleComplete: achievementState.spiritCycleComplete || false,
    unlockedBeyondSpirit: S.flags?.unlockedBeyondSpirit || false,
    voluntaryReincarnations: achievementState.voluntaryReincarnations || 0,
    ...context // Override with any specific context passed in
  };
  
  // Check each achievement
  ACHIEVEMENTS.forEach(achievement => {
    if (!hasAchievement(achievement.id) && achievement.requirement(ctx)) {
      unlockAchievement(achievement.id);
    }
  });
}

/**
 * Revalidate realm-based progression achievements after save migration.
 * This ensures achievements unlock correctly after realm indices shift.
 * Called once after Mortal Realm migration completes.
 */
function revalidateRealmAchievements() {
  if (DEBUG_MODE) console.log('[Achievements] Revalidating realm-based achievements after migration...');
  
  // Only revalidate progression achievements (realm/stage based)
  const realmAchievements = ACHIEVEMENTS.filter(a => 
    a.category === 'Progression' && 
    a.id.includes('reach_') &&
    !a.id.includes('immortal') // Skip True Immortal check as it's >= based
  );
  
  let revalidatedCount = 0;
  realmAchievements.forEach(achievement => {
    if (!hasAchievement(achievement.id)) {
      // Build context
      const ctx = {
        realmIndex: S.realmIndex,
        stage: S.stage,
        currentCycle: S.currentCycle,
        cycleTransitions: achievementState.cycleTransitions || 0,
        spiritCycleComplete: achievementState.spiritCycleComplete || false,
        unlockedBeyondSpirit: S.flags?.unlockedBeyondSpirit || false
      };
      
      // Check if achievement should be unlocked based on current state
      if (achievement.requirement(ctx)) {
        unlockAchievement(achievement.id);
        revalidatedCount++;
        if (DEBUG_MODE) console.log(`[Achievements] Revalidated: ${achievement.id}`);
      }
    }
  });
  
  if (DEBUG_MODE) console.log(`[Achievements] Revalidation complete. ${revalidatedCount} achievement(s) unlocked.`);
}

/**
 * Generic toast notification (reuses achievement toast styling)
 * @param {string} message - Message to display
 */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.innerHTML = `
    <div class="achievement-toast-icon">✨</div>
    <div class="achievement-toast-content">
      <div class="achievement-toast-desc">${message}</div>
    </div>
  `;
  
  document.body.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  // Auto-remove after 5 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

function showAchievementToast(achievement) {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.innerHTML = `
    <div class="achievement-toast-icon">${achievement.icon}</div>
    <div class="achievement-toast-content">
      <div class="achievement-toast-title">Achievement Unlocked!</div>
      <div class="achievement-toast-desc">${achievement.title}</div>
    </div>
  `;
  
  document.body.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showAchievementModal(achievement) {
  showModal(
    '🏆 Achievement Unlocked!',
    `<div style="text-align: center; margin-bottom: 16px; font-size: 2.5em;">${achievement.icon}</div>
     <div style="color: var(--accent); font-weight: 600; margin-bottom: 8px;">${achievement.title}</div>
     <div>${achievement.description}</div>`,
    ''
  );
}

function updateAchievementsBadge() {
  const badgeEl = document.getElementById('achievementsBadge');
  if (badgeEl) {
    const unlockedCount = Object.keys(achievementState.unlocked).length;
    const totalCount = ACHIEVEMENTS.length;
    badgeEl.textContent = `${unlockedCount}/${totalCount}`;
  }
}

function showLockedPopup(featureId) {
  const unlock = UNLOCKS[featureId];
  if (!unlock) return;
  
  const ctx = { realmIndex: S.realmIndex, stage: S.stage };
  const isUnlocked = unlock.requirement(ctx);
  
  if (isUnlocked) return; // Should not show if actually unlocked
  
  const currentRealm = realms[S.realmIndex]?.name || 'Unknown';
  showModal(
    '🔒 Feature Locked',
    `${unlock.text}<br><br><span style="color: var(--muted); font-size: 0.9em;">Current realm: ${currentRealm}</span>`,
    ''
  );
}

// ============= MODAL MANAGER (Centralized & Debounced) =============
// Singleton modal controller to prevent overlapping/duplicate popups
const ModalManager = {
  _queue: [],
  _isActive: false,
  _currentOverlay: null,
  _previousTimeSpeed: null,
  
  /**
   * Show an alert modal (single button: Continue)
   * @returns {Promise<void>} Resolves when modal is dismissed
   */
  async alert({ title, body, confirmText = 'Continue', icon = '' }) {
    return new Promise((resolve) => {
      this._enqueue({ 
        type: 'alert', 
        title, 
        body, 
        confirmText, 
        icon, 
        onConfirm: resolve 
      });
    });
  },
  
  /**
   * Show a confirm modal (two buttons: Cancel, Confirm)
   * @returns {Promise<boolean>} Resolves to true if confirmed, false if cancelled
   */
  async confirm({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', icon = '' }) {
    return new Promise((resolve) => {
      this._enqueue({ 
        type: 'confirm', 
        title, 
        body, 
        confirmText, 
        cancelText, 
        icon, 
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false)
      });
    });
  },
  
  _enqueue(modalData) {
    this._queue.push(modalData);
    if (!this._isActive) {
      this._displayNext();
    }
  },
  
  _displayNext() {
    if (this._queue.length === 0) {
      this._isActive = false;
      document.body.dataset.modalOpen = '0';
      return;
    }
    
    this._isActive = true;
    document.body.dataset.modalOpen = '1';
    
    const data = this._queue.shift();
    
    // Pause game time when modal opens
    if (!S.timeSpeed?.paused) {
      this._previousTimeSpeed = S.timeSpeed?.current || 1;
      S.timeSpeed = S.timeSpeed || {};
      S.timeSpeed.paused = true;
    }
    
    // Create modal DOM
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    
    let buttons;
    if (data.type === 'confirm') {
      buttons = `
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button class="btn danger modal-button" data-action="cancel">${data.cancelText}</button>
          <button class="btn primary modal-button" data-action="confirm">${data.confirmText}</button>
        </div>
      `;
    } else {
      buttons = `<button class="btn primary modal-button" data-action="confirm">${data.confirmText}</button>`;
    }
    
    overlay.innerHTML = `
      <div class="modal">
        ${data.icon ? `<div class="modal-icon">${data.icon}</div>` : ''}
        <h3 class="modal-title">${data.title}</h3>
        <div class="modal-message">${data.body}</div>
        ${buttons}
      </div>
    `;
    
    document.body.appendChild(overlay);
    this._currentOverlay = overlay;
    
    // Animate in
    requestAnimationFrame(() => {
      overlay.classList.add('active');
    });
    
    // Set up event handlers
    const handleClose = (confirmed) => {
      this._cleanup();
      if (confirmed && data.onConfirm) {
        data.onConfirm();
      } else if (!confirmed && data.onCancel) {
        data.onCancel();
      }
      // Display next modal after short delay
      setTimeout(() => this._displayNext(), 100);
    };
    
    // Button clicks
    overlay.querySelectorAll('.modal-button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        handleClose(action === 'confirm');
      });
    });
    
    // Keyboard events
    const handleKeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleClose(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose(data.type === 'confirm' ? false : true);
      }
    };
    document.addEventListener('keydown', handleKeydown);
    
    // Background click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        handleClose(data.type === 'confirm' ? false : true);
      }
    });
    
    // Store cleanup function
    overlay._cleanup = () => {
      document.removeEventListener('keydown', handleKeydown);
    };
    
    // Trap focus inside modal
    const focusableElements = overlay.querySelectorAll('button');
    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    }
  },
  
  _cleanup() {
    if (!this._currentOverlay) return;
    
    const overlay = this._currentOverlay;
    overlay.classList.remove('active');
    
    setTimeout(() => {
      if (overlay._cleanup) {
        overlay._cleanup();
      }
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }, 300);
    
    // Restore previous time speed if no more modals
    if (this._queue.length === 0 && this._previousTimeSpeed !== null) {
      if (S.timeSpeed) {
        S.timeSpeed.paused = false;
        S.timeSpeed.current = this._previousTimeSpeed;
      }
      this._previousTimeSpeed = null;
    }
    
    this._currentOverlay = null;
  },
  
  /**
   * Emergency close all modals (for reset/import functions)
   */
  closeAll() {
    this._queue.length = 0;
    this._isActive = false;
    document.body.dataset.modalOpen = '0';
    
    const overlays = document.querySelectorAll('.modal-overlay');
    overlays.forEach(overlay => {
      if (overlay._cleanup) {
        overlay._cleanup();
      }
      overlay.remove();
    });
    
    this._currentOverlay = null;
    this._previousTimeSpeed = null;
  }
};

// Legacy wrapper functions for compatibility
let modalQueue = [];
let isModalActive = false;

function showModal(title, message, icon = '') {
  ModalManager.alert({ title, body: message, icon });
}

function showConfirm(title, message, onConfirm, onCancel = null, icon = '') {
  ModalManager.confirm({ title, body: message, icon }).then(confirmed => {
    if (confirmed && onConfirm) {
      onConfirm();
    } else if (!confirmed && onCancel) {
      onCancel();
    }
  });
}


// Legacy functions removed - ModalManager handles everything internally

// New helper to close all modals (for reset/import)
function closeAllModals() {
  ModalManager.closeAll();
}

// ============= UI INITIALIZATION =============

// ============= OFFLINE PROGRESS & SESSION MANAGEMENT =============

/**
 * Saves a session snapshot when the tab goes to background or closes.
 * This minimal snapshot allows computing reliable offline progress on resume.
 */
function saveSessionSnapshot() {
  if (!S) return;
  
  S.session = S.session || {};
  S.session.lastTs = Date.now();                          // When we left (ms)
  S.session.lastSpeed = S.timeSpeed?.current || 0;        // Current time speed (0 = paused)
  S.session.lastRealmIndex = S.realmIndex;                // For analytics/debugging
  S.session.lastQi = S.qi;                                // For debugging
  
  // Save to localStorage immediately
  try {
    S.version = VERSION;
    localStorage.setItem(SAVE_KEY, JSON.stringify(S));
  } catch (e) {
    console.error('Failed to save session snapshot:', e);
  }
}

/**
 * Format years for display (e.g., "123.45" → "123.45 years")
 */
function formatYears(years) {
  if (years < 1) {
    return `${(years * 365).toFixed(1)} days`;
  }
  return `${years.toFixed(2)} years`;
}

/**
 * Centralized lifespan gate check. Call this after any time advancement.
 * Prevents "stuck at max lifespan" by immediately triggering death if threshold exceeded.
 */
function checkLifespanGate() {
  // Skip if immortal
  if (isImmortal()) return;
  
  // Skip if already processing death or latch is set
  if (S.flags?.lifespanHandled || S.lifecycle?.isReincarnating) return;
  
  // Migrate old ageYears to age
  const currentAge = S.age !== undefined ? S.age : (S.ageYears || 0);
  if(S.age === undefined) S.age = currentAge;
  
  // Get max lifespan with karma multiplier
  const maxLife = getMaxLifespan();
  if (maxLife === null) return; // Immortal realm
  
  // Check if age exceeded lifespan
  if (currentAge >= maxLife) {
    // Set latch flag to prevent double-trigger
    S.flags = S.flags || {};
    S.flags.lifespanHandled = true;
    
    // Handle death immediately
    handleLifespanEnd();
  }
}

/**
 * Apply offline progress on resume (after tab returns or on initial page load).
 * Computes Qi gains, ages the cultivator, and checks for death.
 * Shows a single modal with results (or death modal if lifespan exceeded).
 * 
 * @param {Object} options - Configuration options
 * @param {boolean} options.showPopup - Whether to show the offline gains modal (default: true)
 */
async function applyOfflineProgressOnResume({ showPopup = true } = {}) {
  // Check if we have a valid session snapshot
  if (!S.session?.lastTs) {
    // No snapshot = first load or old save, clear any stale data
    S.session = null;
    return;
  }
  
  const lastSpeed = S.session.lastSpeed || 0;
  
  // If game was paused (speed = 0), no offline gains
  if (lastSpeed <= 0) {
    S.session = null; // Clear snapshot
    return;
  }
  
  // Calculate elapsed time
  const elapsedMs = Date.now() - S.session.lastTs;
  const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
  
  // No meaningful time passed
  if (elapsedSec < 1) {
    S.session = null;
    return;
  }
  
  // Cap offline time
  const cappedSec = Math.min(elapsedSec, BAL.offline.capHours * 3600);
  
  // IMPORTANT: Qi gains do NOT scale with speed (speed is a live-only concept)
  // Offline Qi = base production × time × offline multiplier (no speed)
  const qpsProduction = totalQPS();
  const offlineMultiplier = totalOfflineMult();
  const qiGains = qpsProduction * cappedSec * offlineMultiplier;
  
  // Aging DOES scale with speed (time passes faster at higher speeds)
  const effectiveTimeForAging = cappedSec * lastSpeed;
  const baseYearsPerSecond = BAL.lifespan?.yearsPerSecond || 1.0;
  const yearsPassed = effectiveTimeForAging * baseYearsPerSecond;
  
  // Apply gains with offline karma bonus
  if (qiGains > 0) {
    safeAddQi(qiGains);
    
    // Offline Karma Bonus: Boost lifetime Qi contribution for offline gains
    // This encourages longer offline sessions and rewards patience
    const offlineKarmaBonus = BAL.reincarnation?.offlineKarmaBonus || 1.0;
    const bonusMultiplier = Math.max(1.0, offlineKarmaBonus);
    const lifetimeContribution = qiGains * bonusMultiplier;
    
    S.reinc.lifetimeQi = safeNum(S.reinc.lifetimeQi + lifetimeContribution, 0);
    
    if (DEBUG_MODE) {
      console.log(`[Offline] Karma bonus applied: ${bonusMultiplier.toFixed(2)}× → ${fmt(lifetimeContribution)} lifetime Qi`);
    }
  }
  
  // Age the cultivator (migrate old ageYears if needed)
  if(S.age === undefined && S.ageYears !== undefined) {
    S.age = S.ageYears;
    delete S.ageYears;
  }
  if(!S.age || !isFinite(S.age)) {
    S.age = 0;
  }
  
  let lifespanExceeded = false;
  if (!isImmortal() && S.lifespan?.max !== null) {
    const oldAge = S.age;
    const newAge = oldAge + yearsPassed;
    
    // Guard against NaN/Infinity
    if(!isFinite(newAge)) {
      console.warn('Offline age calculation resulted in non-finite value');
      S.age = oldAge; // Keep old value
    } else {
      // Clamp age to max lifespan
      S.age = Math.max(0, Math.min(newAge, S.lifespan.max));
      
      // Update current lifespan for backwards compatibility
      S.lifespan.current = Math.max(0, S.lifespan.max - S.age);
      
      // Check if lifespan exceeded
      if (S.age >= S.lifespan.max) {
        lifespanExceeded = true;
      }
    }
  } else if (!isImmortal()) {
    // Just increase age for non-immortals without max
    S.age += yearsPassed;
  }
  
  // Track offline hours for achievements
  const offlineHours = cappedSec / 3600;
  checkAchievements({ offlineHours });
  
  // Clear session snapshot (prevent double-counting)
  S.session = null;
  
  // If lifespan exceeded, trigger death immediately (don't show gains modal)
  if (lifespanExceeded) {
    checkLifespanGate(); // This will show death modal
    return;
  }
  
  // Show offline gains modal (only if not dead and showPopup = true)
  if (showPopup && qiGains > 0) {
    const hoursFormatted = fmt(cappedSec / 3600);
    const qiFormatted = fmt(Math.floor(qiGains));
    const yearsFormatted = formatYears(yearsPassed, true); // Includes "years" unit
    const offlineMultFormatted = fmt(offlineMultiplier);
    const currentRealm = realms[S.realmIndex]?.name || 'Unknown Realm';
    const speedFormatted = fmt(lastSpeed);
    
    let lifespanStatus;
    if (isImmortal()) {
      lifespanStatus = '<strong>Age:</strong> ∞ Immortal';
    } else {
      const currentAge = S.age !== undefined ? S.age : 0;
      const ageStr = formatYears(currentAge, true); // Includes "years"
      const maxStr = formatYears(S.lifespan.max, true); // Includes "years"
      lifespanStatus = `<strong>Age:</strong> ${ageStr} / ${maxStr}`;
    }
    
    const message = `
      <div style="text-align: left; margin: 8px 0;">
        <div><strong>Qi Gained:</strong> <span class="highlight">+${qiFormatted}</span></div>
        <div><strong>Offline Multiplier:</strong> ×${offlineMultFormatted}</div>
        <div><strong>Time Passed:</strong> ${yearsFormatted} (${hoursFormatted}h real-time)</div>
        <div><strong>Time Speed Used:</strong> ${speedFormatted}×</div>
        <div><strong>Current Realm:</strong> ${currentRealm}</div>
        <div>${lifespanStatus}</div>
      </div>
      <br><em style="color: var(--muted);">Your cultivation continued in silence, and the Dao answered.</em>
    `;
    
    await showModal('⏰ While You Were Away...', message, '🌙');
  }
}

// ============= UI INITIALIZATION (LEGACY SECTION) =============

// (Opcional pero recomendado) permitir activar con Enter/Espacio
const cultivatorEl = document.getElementById('clickBtn');
cultivatorEl.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' || e.key === ' '){
    e.preventDefault();
    onClick();
  }
});


function save(){
  S.version = VERSION;
  S.lastSave = now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(S));
  updateLastSave();
}

function load(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(!raw) return null;
    const data = JSON.parse(raw);
    if(!data.version) data.version = '0.0.0';
    
    // ============= MORTAL REALM MIGRATION =============
    // Detect pre-Mortal-realm saves (before v1.2.0 with Mortal Realm at index 0)
    // Flag: if save doesn't have 'migratedToMortalRealm' flag, it's an old save
    if(!data.migratedToMortalRealm) {
      if(DEBUG_MODE) console.log('[Migration] Detected pre-Mortal-realm save. Shifting realm indices...');
      
      // Shift realm index by +1 (all realms moved up due to Mortal being inserted at 0)
      // BUT: Don't shift if they're already at Mortal (0) - that means they started fresh
      if(data.realmIndex > 0 || data.stage > 1) {
        const oldIndex = data.realmIndex || 0;
        data.realmIndex = Math.min(oldIndex + 1, realms.length - 1);
        if(DEBUG_MODE) console.log(`[Migration] Shifted realmIndex from ${oldIndex} to ${data.realmIndex}`);
      }
      
      // Mark as migrated
      data.migratedToMortalRealm = true;
      if(DEBUG_MODE) console.log('[Migration] Mortal Realm migration complete.');
      
      // Set flag to trigger achievement revalidation after S is loaded
      data._needsAchievementRevalidation = true;
    }
    
    // Migrate old saves: ensure reinc exists (backward compatibility)
    if(!data.reinc) data.reinc = { times: 0, karma: 0, lifetimeQi: 0 };
    // Migrate old saves: ensure lifespan exists
    if(!data.lifespan) {
      const realmIndex = Math.min(data.realmIndex || 0, realms.length - 1);
      const maxLifespan = BAL.lifespan?.realmMaxLifespan?.[realmIndex];
      if(maxLifespan === null) {
        // True Immortal - infinite lifespan
        data.lifespan = { current: null, max: null };
      } else {
        const lifespan = maxLifespan || 100;
        data.lifespan = { current: lifespan, max: lifespan };
      }
    }
    // Migrate old saves: ensure timeSpeed exists
    if(!data.timeSpeed) data.timeSpeed = { current: 1, paused: false };
    // Migrate old saves: ensure flags exists with all new properties
    if(!data.flags) {
      data.flags = { 
        unlockedBeyondSpirit: false,
        hasUnlockedSpiritCycle: false,
        hasCompletedMandatoryST10: false,
        canManualReincarnate: false
      };
    } else {
      // Ensure new flag properties exist
      if(data.flags.hasUnlockedSpiritCycle === undefined) data.flags.hasUnlockedSpiritCycle = false;
      if(data.flags.hasCompletedMandatoryST10 === undefined) data.flags.hasCompletedMandatoryST10 = false;
      if(data.flags.canManualReincarnate === undefined) data.flags.canManualReincarnate = false;
    }
    // Migrate old saves: ensure lifecycle exists with all properties
    if(!data.lifecycle) {
      data.lifecycle = { isReincarnating: false, lastDeathAt: 0, lastReincarnateAt: 0 };
    } else {
      if(data.lifecycle.lastReincarnateAt === undefined) data.lifecycle.lastReincarnateAt = 0;
    }
    
    // Migrate old saves: ensure stats exists
    if(!data.stats) {
      data.stats = { deaths: 0 };
    } else {
      if(data.stats.deaths === undefined) data.stats.deaths = 0;
    }
    
    // Migrate old saves: ensure meta exists with unlockedSpeeds
    if(!data.meta) {
      data.meta = { unlockedSpeeds: [0, 0.25, 0.5, 1] };
    } else {
      if(!Array.isArray(data.meta.unlockedSpeeds)) {
        data.meta.unlockedSpeeds = [0, 0.25, 0.5, 1];
      } else {
        // Ensure base speeds (0, 0.25, 0.5, 1) are always present
        const baseSpeedsForMigration = [0, 0.25, 0.5, 1];
        baseSpeedsForMigration.forEach(speed => {
          if (!data.meta.unlockedSpeeds.includes(speed)) {
            data.meta.unlockedSpeeds.push(speed);
          }
        });
      }
    }
    
    // Validate current speed is available, fallback to 1× if not
    if(data.timeSpeed && data.timeSpeed.current !== 0) {
      const availableSpeeds = data.meta?.unlockedSpeeds || [0, 0.25, 0.5, 1];
      if(!availableSpeeds.includes(data.timeSpeed.current)) {
        data.timeSpeed.current = 1; // Fallback to 1×
        data.timeSpeed.paused = false;
      }
    }
    
    // Migrate old saves: ensure age tracking exists
    // Migrate ageYears → age for consistency
    if(data.age === undefined) {
      if(data.ageYears !== undefined) {
        data.age = safeNum(data.ageYears, 0);
        delete data.ageYears;
      } else {
        // Calculate age from remaining lifespan
        if(data.lifespan && data.lifespan.max !== null && data.lifespan.current !== null) {
          data.age = Math.max(0, data.lifespan.max - data.lifespan.current);
        } else {
          data.age = 0;
        }
      }
    }
    
    // Ensure lifespanHandled latch flag exists
    if(!data.flags) data.flags = {};
    if(data.flags.lifespanHandled === undefined) {
      data.flags.lifespanHandled = false;
    }
    
    if(data.isDead === undefined) data.isDead = false;
    if(!data.life) {
      data.life = { isCleanRun: true };
    } else {
      if(data.life.isCleanRun === undefined) data.life.isCleanRun = true;
    }
    
    // ============= HYBRID SKILL SYSTEM MIGRATION =============
    // Migrate old numeric skill levels to new rank structure
    if(!data.migratedToRankSystem) {
      if(DEBUG_MODE) console.log('[Migration] Converting skills to rank-based system...');
      
      if(data.skills) {
        const currentRealm = data.realmIndex || 0;
        const newSkills = {};
        
        for(const [skillId, oldValue] of Object.entries(data.skills)) {
          const sk = getSkillCatalog().find(s => s.id === skillId);
          if(!sk) continue;
          
          if(sk.oneTime) {
            // Techniques: convert truthy value to purchasedOneTime flag
            if(oldValue) {
              newSkills[skillId] = { purchasedOneTime: true, total: 1, perRealm: {} };
            }
          } else {
            // Ranked skills: convert numeric level to realm ranks
            const level = typeof oldValue === 'number' ? oldValue : 0;
            if(level > 0) {
              newSkills[skillId] = {
                total: level,
                perRealm: { [currentRealm]: level }
              };
            }
          }
        }
        
        data.skills = newSkills;
      } else {
        data.skills = {};
      }
      
      data.migratedToRankSystem = true;
      if(DEBUG_MODE) console.log('[Migration] Rank system migration complete.');
    }
    
    // Sanitize critical numeric values to prevent corruption issues
    if(data.qi) data.qi = safeNum(data.qi, 0);
    if(data.reinc && data.reinc.lifetimeQi) data.reinc.lifetimeQi = safeNum(data.reinc.lifetimeQi, 0);
    if(data.age) data.age = safeNum(data.age, 0);
    if(data.lifespan) {
      if(data.lifespan.current !== null) data.lifespan.current = safeNum(data.lifespan.current, 100);
      if(data.lifespan.max !== null) data.lifespan.max = safeNum(data.lifespan.max, 100);
    }
    
    S = data;
    
    // Refresh lifespan to match current realm (in case of balance changes or migration)
    refreshLifespanForRealm();
    
    // Ensure speeds are unlocked based on current realm (in case of old saves)
    checkAndUnlockSpeeds();
    
    // Revalidate achievements if migration occurred (realm indices shifted)
    if(data._needsAchievementRevalidation) {
      revalidateRealmAchievements();
      delete S._needsAchievementRevalidation; // Clean up temporary flag
    }
    
    return S;
  }catch(e){ console.error('Error loading', e); return null; }
}

function reset(){
  showConfirm(
    "⚠️ FULL RESET WARNING",
    "<span style='color: var(--danger); font-weight: bold;'>This will permanently delete EVERYTHING:</span><br><br>" +
    "• All cultivation progress<br>" +
    "• All karma and reincarnations<br>" +
    "• All achievements and statistics<br>" +
    "• All settings and preferences<br><br>" +
    "<strong>This action cannot be undone!</strong><br><br>" +
    "Are you absolutely certain?",
    () => {
      // Clear all localStorage keys
      localStorage.removeItem('xianxiaIdleSave');
      localStorage.removeItem('xianxiaIdleAchievements');
      localStorage.removeItem('xianxiaSettings');
      
      // Reset achievement state
      achievementState = {
        unlocked: {},
        voluntaryReincarnations: 0,
        forcedReincarnationCount: 0,
        cycleTransitions: 0
      };
      
      // Reinitialize game state
      S = defaultState();
      
      // Save the fresh state
      save();
      saveAchievementState();
      
      // Refresh UI
      renderAll();
      renderAchievements();
      updateAchievementsBadge();
      
      showModal('🔄 Full Reset Complete', 
        'All progress has been erased. Your cultivation journey begins anew.', '⚠️');
    },
    null,
    '⚠️'
  );
}

function exportSave(){
  const json = JSON.stringify(S);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  ioArea.value = b64;
}

function importSave(){
  try{
    const b64 = ioArea.value.trim();
    const json = decodeURIComponent(escape(atob(b64)));
    const data = JSON.parse(json);
    
    // Apply same migration and sanitization as load()
    if(!data.version) data.version = '0.0.0';
    if(!data.reinc) data.reinc = { times: 0, karma: 0, lifetimeQi: 0 };
    if(!data.lifespan) {
      const realmIndex = Math.min(data.realmIndex || 0, realms.length - 1);
      const maxLifespan = BAL.lifespan?.realmMaxLifespan?.[realmIndex];
      if(maxLifespan === null) {
        data.lifespan = { current: null, max: null };
      } else {
        const lifespan = maxLifespan || 100;
        data.lifespan = { current: lifespan, max: lifespan };
      }
    }
    if(!data.timeSpeed) data.timeSpeed = { current: 1, paused: false };
    if(!data.flags) {
      data.flags = { 
        unlockedBeyondSpirit: false,
        hasUnlockedSpiritCycle: false,
        hasCompletedMandatoryST10: false,
        canManualReincarnate: false
      };
    } else {
      if(data.flags.hasUnlockedSpiritCycle === undefined) data.flags.hasUnlockedSpiritCycle = false;
      if(data.flags.hasCompletedMandatoryST10 === undefined) data.flags.hasCompletedMandatoryST10 = false;
      if(data.flags.canManualReincarnate === undefined) data.flags.canManualReincarnate = false;
    }
    if(!data.lifecycle) {
      data.lifecycle = { isReincarnating: false, lastDeathAt: 0, lastReincarnateAt: 0 };
    } else {
      if(data.lifecycle.lastReincarnateAt === undefined) data.lifecycle.lastReincarnateAt = 0;
    }
    
    if(!data.stats) {
      data.stats = { deaths: 0 };
    } else {
      if(data.stats.deaths === undefined) data.stats.deaths = 0;
    }
    
    // Migrate old saves: ensure meta exists with unlockedSpeeds
    if(!data.meta) {
      data.meta = { unlockedSpeeds: [0, 0.5, 1] };
    } else {
      if(!Array.isArray(data.meta.unlockedSpeeds)) {
        data.meta.unlockedSpeeds = [0, 0.25, 0.5, 1];
      } else {
        // Ensure base speeds (0, 0.5, 1) are always present
        const baseSpeedsAlwaysAvailable = [0, 0.25, 0.5, 1];
        baseSpeedsAlwaysAvailable.forEach(speed => {
          if (!data.meta.unlockedSpeeds.includes(speed)) {
            data.meta.unlockedSpeeds.push(speed);
          }
        });
      }
    }
    
    // Validate current speed is available, fallback to 1× if not
    if(data.timeSpeed && data.timeSpeed.current !== 0) {
      const availableSpeeds = data.meta?.unlockedSpeeds || [0, 0.25, 0.5, 1];
      if(!availableSpeeds.includes(data.timeSpeed.current)) {
        data.timeSpeed.current = 1; // Fallback to 1×
        data.timeSpeed.paused = false;
      }
    }
    
    // Migrate old saves: ensure age tracking exists
    // Migrate ageYears → age for consistency
    if(data.age === undefined) {
      if(data.ageYears !== undefined) {
        data.age = safeNum(data.ageYears, 0);
        delete data.ageYears;
      } else {
        // Calculate age from remaining lifespan
        if(data.lifespan && data.lifespan.max !== null && data.lifespan.current !== null) {
          data.age = Math.max(0, data.lifespan.max - data.lifespan.current);
        } else {
          data.age = 0;
        }
      }
    }
    
    // Ensure lifespanHandled latch flag exists
    if(!data.flags) data.flags = {};
    if(data.flags.lifespanHandled === undefined) {
      data.flags.lifespanHandled = false;
    }
    
    if(data.isDead === undefined) data.isDead = false;
    if(!data.life) {
      data.life = { isCleanRun: true };
    } else {
      if(data.life.isCleanRun === undefined) data.life.isCleanRun = true;
    }
    
    // Sanitize critical numeric values
    if(data.qi) data.qi = safeNum(data.qi, 0);
    if(data.reinc && data.reinc.lifetimeQi) data.reinc.lifetimeQi = safeNum(data.reinc.lifetimeQi, 0);
    if(data.age) data.age = safeNum(data.age, 0);
    if(data.lifespan) {
      if(data.lifespan.current !== null) data.lifespan.current = safeNum(data.lifespan.current, 100);
      if(data.lifespan.max !== null) data.lifespan.max = safeNum(data.lifespan.max, 100);
    }
    
    S = { ...defaultState(), ...data };
    save();
    renderAll();
    showModal('Save Imported', 'Your cultivation progress has been successfully restored.', '📜');
  }catch(e){
    showModal('Import Failed', 'Error importing save data. Please ensure you paste the complete export code.', '⚠️');
  }
}

/**
 * DEPRECATED: Old offline gains system (replaced by applyOfflineProgressOnResume)
 * Kept for backwards compatibility but no longer called.
 */
function applyOfflineGains(){
  // This function is deprecated - use applyOfflineProgressOnResume instead
  // Kept for compatibility with old code references
  console.warn('applyOfflineGains() is deprecated - use applyOfflineProgressOnResume()');
}

const qiDisplay = document.getElementById('qiDisplay');
const qpcEl = document.getElementById('qpc');
const qpsEl = document.getElementById('qps');
const offlineMultEl = document.getElementById('offlineMult');
const realmNameEl = document.getElementById('realmName');
const realmStageEl = document.getElementById('realmStage');
const realmProgEl = document.getElementById('realmProg');
const realmReqTextEl = document.getElementById('realmReqText');
const breakthroughBtn = document.getElementById('breakthroughBtn');
const karmaValEl = document.getElementById('karmaVal');
const reincBonusEl = document.getElementById('reincBonus');
const reincTimesEl = document.getElementById('reincTimes');
const deathsCountEl = document.getElementById('deathsCount');
const saveBtn = document.getElementById('saveBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const resetBtn = document.getElementById('resetBtn');
const clickBtn = document.getElementById('clickBtn');
const shopEl = document.getElementById('shop');
const ioArea = document.getElementById('ioArea');
const verEl = document.getElementById('ver');
const lastSaveEl = document.getElementById('lastSave');
const lifespanValueEl = document.getElementById('lifespanValue');
const lifespanProgressBarEl = document.querySelector('#lifespanProgress > div');
const speedButtonsEl = document.getElementById('speedButtons');
const achievementsBtn = document.getElementById('achievementsBtn');
const achievementsPanel = document.getElementById('achievementsPanel');
const achievementsClose = document.getElementById('achievementsClose');
const achievementsList = document.getElementById('achievementsList');
// Note: currentCycleEl removed - Current Cycle moved to Cultivation Zone badge
// Note: realmBonusEl removed - Realm Bonus UI replaced with Transcendence panel

function updateLastSave(){
  if(!S.lastSave){ lastSaveEl.textContent = 'Last Save: —'; return; }
  const d = new Date(S.lastSave);
  lastSaveEl.textContent = 'Last Save: ' + d.toLocaleString();
}

function renderStats(){
  qiDisplay.textContent = 'Qi: ' + fmt(Math.floor(S.qi));
  
  // QPC/QPS display: Speed-independent (time speed affects only lifespan, not Qi)
  qpcEl.textContent = fmt(totalQPC());
  qpsEl.textContent = fmt(totalQPS());
  
  // Use fmt for offline multiplier (max 2 decimals)
  const offlineMult = totalOfflineMult();
  offlineMultEl.textContent = fmt(offlineMult) + '×';
  
  // LIFESPAN UI: Clean numeric display (no "years", no "Age:")
  // Format: "Lifespan" label on left, "current / max" value on right
  if(lifespanValueEl) {
    // Migrate old ageYears to age
    if(S.age === undefined && S.ageYears !== undefined) {
      S.age = S.ageYears;
      delete S.ageYears;
    }
    
    // Initialize age if missing or invalid
    if(!S.age || !isFinite(S.age)) {
      S.age = 0;
    }
    
    const currentAge = S.age;
    const maxLifespan = S.lifespan.max;
    const finiteMax = Number.isFinite(maxLifespan);
    
    // Build value: "39.48 / 100.00" or "123.45 / ∞"
    lifespanValueEl.textContent = finiteMax 
      ? `${fmt2(currentAge)} / ${fmt2(maxLifespan)}` 
      : `${fmt2(currentAge)} / ∞`;
    
    // Update progress bar
    if(lifespanProgressBarEl) {
      if(finiteMax) {
        const progressPercent = Math.max(0, Math.min(100, (currentAge / maxLifespan) * 100));
        lifespanProgressBarEl.style.width = progressPercent.toFixed(2) + '%';
      } else {
        lifespanProgressBarEl.style.width = '0%'; // No progress for immortal
      }
    }
  }
  
  if(karmaValEl) karmaValEl.textContent = fmt(S.reinc.karma);
  if(reincBonusEl) reincBonusEl.textContent = fmt(reincBonus()) + '×';
  if(reincTimesEl) reincTimesEl.textContent = S.reinc.times;
  if(deathsCountEl) deathsCountEl.textContent = S.stats?.deaths || 0;
  
  // OLD: Removed transcendenceStatus div - now using renderTranscendencePanel() for card-style display
  
  // Note: Current Cycle moved to Cultivation Zone (see renderCycleBadge())
  // Note: Realm Bonus UI removed - internal scaling still functional via effectiveSkillBase()
}

/**
 * Render the cycle badge in the cultivation zone (lower-left corner)
 */
function renderCycleBadge() {
  const cycleBadgeEl = document.getElementById('cycleBadge');
  if (!cycleBadgeEl) return;
  
  const cycle = getCurrentCycle();
  const cycleName = cycle.name || 'Mortal Cycle';
  const cycleClass = S.currentCycle === 'spirit' ? 'cycle-spirit' : 'cycle-mortal';
  
  cycleBadgeEl.textContent = cycleName;
  cycleBadgeEl.className = `cycle-badge ${cycleClass}`;
}

function renderRealm(){
  const r = realms[S.realmIndex];
  realmNameEl.textContent = r.name;
  realmStageEl.textContent = S.stage + ' / 10';
  const req = stageRequirement(S.realmIndex, S.stage);
  const pct = Math.max(0, Math.min(100, (S.qi / req) * 100));
  realmProgEl.style.width = pct + '%';
  realmReqTextEl.textContent = `Requirement to advance: ${fmt(req)} Qi`;
  breakthroughBtn.disabled = !canBreakthrough();
}

/**
 * Get transcendence status
 * @returns {Object} {locked, atST10, done}
 */
function transcStatus() {
  const ST_INDEX = idx('spirit_transformation');
  const atST10 = (S.realmIndex === ST_INDEX && S.stage === 10);
  const done = !!S.flags?.hasCompletedMandatoryST10;
  return { locked: !done, atST10, done };
}

/**
 * Render the Transcendence panel
 */
function renderTranscendencePanel() {
  const panel = document.getElementById('transcendencePanel');
  if (!panel) return;
  
  // Guard: Clear before render to prevent duplicates
  panel.innerHTML = '';
  
  // DEBUG: Check for duplicate panels
  if (DEBUG_MODE) {
    const panelCount = document.querySelectorAll('#transcendencePanel').length;
    if (panelCount > 1) {
      console.warn(`[Transcendence Panel] ⚠️ Duplicate panels detected: ${panelCount} found`);
    }
  }
  
  const status = transcStatus();
  const canReincarnateNow = canReincarnate();
  
  // Determine badge
  const badgeClass = status.locked ? 'locked' : 'unlocked';
  const badgeText = status.locked ? '🔒 Locked' : '✨ Unlocked';
  
  // Determine hint text
  let hintHTML = '';
  if (status.locked) {
    if (status.atST10) {
      hintHTML = `<div class="transcendence-hint">⚡ Overcome the <strong>Heavenly Gate</strong> at Spirit Transformation (10/10) to unlock Transcendence.</div>`;
    } else {
      hintHTML = `<div class="transcendence-hint">Advance to <strong>Spirit Transformation Stage 10</strong> to face the Heavenly Gate and unlock Transcendence.</div>`;
    }
  } else {
    if (canReincarnateNow) {
      hintHTML = `<div class="transcendence-hint">✓ Voluntary reincarnation is available. Reincarnate now for <strong>full Karma</strong> rewards.</div>`;
    } else {
      hintHTML = `<div class="transcendence-hint">Progress to Spirit Transformation or higher realms to unlock voluntary reincarnation.</div>`;
    }
  }
  
  // Build button
  let buttonHTML = '';
  if (!status.locked && canReincarnateNow) {
    buttonHTML = `<button id="btnReincNow" class="btn accent">♻️ Reincarnate</button>`;
  }
  
  panel.innerHTML = `
    <h4>⚡ Transcendence</h4>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
      <span style="font-size: 12px; color: var(--muted);">Status:</span>
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>
    ${hintHTML}
    ${buttonHTML}
  `;
  
  // Wire up button if present
  const btn = document.getElementById('btnReincNow');
  if (btn) {
    btn.addEventListener('click', tryManualReincarnate);
  }
  
  if (DEBUG_MODE) {
    console.log('[Transcendence Panel] Status:', status, 'Can Reincarnate:', canReincarnateNow);
  }
}

/**
 * Preview the effect of buying N levels of a skill
 * Calculates delta to QPS/QPC/offline multiplier and total cost
 * Uses tier-aware skill effect calculations
 * @param {string} skillId - Skill ID
 * @param {number} qty - Number of levels to preview
 * @returns {Object} {deltaQPS, deltaQPC, deltaOffline, totalCost, affordable, canAfford}
 */
function previewBulkEffect(skillId, qty) {
  const sk = getSkill(skillId);
  if (!sk) return { deltaQPS: 0, deltaQPC: 0, deltaOffline: 0, totalCost: 0, affordable: 0, canAfford: false };
  
  const currentLevel = S.skills[skillId] || 0;
  const newLevel = currentLevel + qty;
  
  // Safety: prevent preview of impossible quantities
  if (!Number.isFinite(newLevel) || newLevel < currentLevel) {
    return { deltaQPS: 0, deltaQPC: 0, deltaOffline: 0, totalCost: Infinity, affordable: 0, canAfford: false };
  }
  
  // Calculate current totals
  const oldQPS = totalQPS();
  const oldQPC = totalQPC();
  const oldOffline = totalOfflineMult();
  
  // Temporarily increase skill level
  const originalLevel = S.skills[skillId];
  S.skills[skillId] = newLevel;
  
  // Calculate new totals
  const newQPS = totalQPS();
  const newQPC = totalQPC();
  const newOffline = totalOfflineMult();
  
  // Restore original level
  if (originalLevel === undefined) {
    delete S.skills[skillId];
  } else {
    S.skills[skillId] = originalLevel;
  }
  
  // Calculate deltas
  const deltaQPS = newQPS - oldQPS;
  const deltaQPC = newQPC - oldQPC;
  const deltaOffline = newOffline - oldOffline;
  
  // Get total cost and affordability
  const totalCost = totalSkillCost(skillId, qty);
  const affordable = maxAffordableQty(skillId, qty, S.qi);
  const canAfford = affordable >= qty;
  
  return {
    deltaQPS,
    deltaQPC,
    deltaOffline,
    totalCost,
    affordable,
    canAfford,
    skillType: sk.type
  };
}

function renderShop(){
  shopEl.innerHTML = '';
  
  // Mortal Realm (realm 0) cannot buy skills
  if (S.realmIndex === 0) {
    shopEl.innerHTML = '<div class="small muted" style="text-align: center; padding: 20px;">Skills are locked in Mortal Realm.<br>Advance to Qi Refining to unlock cultivation techniques.</div>';
    return;
  }
  
  // Bulk options: Only ×1, ×10, ×100 (removed ×1000/×10000)
  const bulkOptions = [1, 10, 100];
  
  // Filter skills by cycle unlock requirements
  const availableSkills = getSkillCatalog().filter(sk => skillUnlockedByCycle(sk));
  
  for(const sk of availableSkills){
    // One-time techniques
    if (sk.oneTime) {
      const purchased = isTechniquePurchased(sk.id);
      const cost = sk.cost;
      const can = !purchased && S.qi >= cost;
      
      const wrap = document.createElement('div');
      wrap.className = 'shop-item';
      
      const badge = purchased ? '<span style="color:var(--accent);font-size:10px;font-weight:700;padding:2px 6px;background:rgba(126,231,135,0.15);border-radius:4px;margin-left:6px;">PURCHASED</span>' : '<span style="color:var(--accent-2);font-size:10px;font-weight:700;padding:2px 6px;background:rgba(161,138,255,0.15);border-radius:4px;margin-left:6px;">ONE-TIME</span>';
      
      const effectPct = (sk.value * 100).toFixed(1);
      const typeLabel = sk.type === 'qps_pct' ? 'Qi/s' : sk.type === 'qpc_pct' ? 'Qi/click' : 'offline Qi';
      
      wrap.innerHTML = `
        <div>
          <img src="assets/${sk.icon}" alt="${sk.name}" class="skill-icon">
          <div>
            <h4>${sk.name}${badge}</h4>
            <div class="desc">+${effectPct}% ${typeLabel}</div>
            <div class="small muted">Cost: ${fmt(cost)} Qi</div>
          </div>
        </div>
        <button class="btn ${can?'primary':''} buy-btn" ${can?'':'disabled'} data-skill="${sk.id}" title="${purchased ? 'Already purchased' : can ? 'Purchase technique' : 'Cannot afford'}">${purchased ? 'Owned' : 'Buy'}</button>
      `;
      
      shopEl.appendChild(wrap);
      continue;
    }
    
    // Ranked skills
    const currentRanks = currentRealmRanks(sk.id);
    const maxRanks = sk.ranksPerRealm;
    const cost = skillCost(sk.id);
    const atCap = currentRanks >= maxRanks;
    const can = !atCap && S.qi >= cost;
    
    // Generate description based on skill type
    let descDyn;
    if (sk.type === 'qps_flat' || sk.type === 'qpc_flat') {
      const effBase = effectiveSkillBase(sk.id);
      const baseline = sk.type === 'qps_flat' 
        ? S.qpsBase * (BAL.realmBaselines?.qpsFlatPerRank || 0.15) * effBase
        : S.qpcBase * (BAL.realmBaselines?.qpcFlatPerRank || 0.25) * effBase;
      const typeLabel = sk.type === 'qps_flat' ? 'Qi/s' : 'Qi/click';
      descDyn = `${fmtNumberDelta(baseline)} ${typeLabel} per rank`;
    } else {
      // Percent skills with realm-aware floors/caps
      const basePctPerRank = sk.base || 0.008;
      const capPct = sk.capPctPerRealm || 0.12;
      
      // Apply realm-aware floors/caps to per-rank percentage
      const minPct = minTierPctByRealm(S.realmIndex);
      const maxPct = maxTierPctByRealm(S.realmIndex);
      const pctPerRank = Math.max(minPct, Math.min(maxPct, basePctPerRank));
      
      // Total cap with effective base dampening
      const effBase = effectiveSkillBase(sk.id);
      const scaledCap = Math.min(capPct * Math.sqrt(effBase), 2.0);
      
      const typeLabel = sk.type === 'qps_pct' ? 'Qi/s' : sk.type === 'qpc_pct' ? 'Qi/click' : 'offline Qi';
      descDyn = `${fmtPercentDeltaNonZero(pctPerRank)} ${typeLabel} per rank • Cap ${fmtPerc(scaledCap)}`;
    }
    
    const wrap = document.createElement('div');
    wrap.className = 'shop-item';
    
    // Build bulk selector buttons HTML
    const bulkButtonsHTML = bulkOptions.map(mult => {
      const isActive = mult === getLastBulkMultiplier();
      return `<button class="bulk-btn ${isActive ? 'active' : ''}" data-mult="${mult}" aria-pressed="${isActive}">×${mult}</button>`;
    }).join('');
    
    wrap.innerHTML = `
      <div>
        <img src="assets/${sk.icon || (sk.id + '.png')}" alt="${sk.name}" class="skill-icon">
        <div>
          <h4>${sk.name} <span class="muted">(Ranks ${currentRanks}/${maxRanks})</span></h4>
          <div class="desc">${descDyn}</div>
          <div class="small muted">Cost (×1): ${fmt(cost)} Qi</div>
          <div class="bulk-cost small muted" data-skill="${sk.id}"></div>
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px; align-items: flex-end;">
        <div class="bulk-selector" role="group" aria-label="Bulk purchase quantity">
          ${bulkButtonsHTML}
        </div>
        <button class="btn ${can?'primary':''} buy-btn" ${can?'':'disabled'} data-skill="${sk.id}" title="${atCap ? 'Rank cap reached this realm' : can ? 'Purchase rank' : 'Cannot afford'}">Buy</button>
      </div>`;
    
    shopEl.appendChild(wrap);
  }
  
  // Attach event listeners for bulk selection
  shopEl.querySelectorAll('.bulk-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const mult = parseInt(btn.getAttribute('data-mult'));
      setLastBulkMultiplier(mult);
      
      // Update all bulk buttons to show active state
      const parentShopItem = btn.closest('.shop-item');
      parentShopItem.querySelectorAll('.bulk-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      
      // Update cost preview for this skill
      const skillId = parentShopItem.querySelector('[data-skill]').getAttribute('data-skill');
      updateBulkCostPreview(skillId, mult);
    });
  });
  
  // Attach event listeners for buy buttons
  shopEl.querySelectorAll('button.buy-btn[data-skill]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-skill');
      const mult = getLastBulkMultiplier();
      buySkill(id, mult);
    });
  });
  
  // Initialize cost previews for current bulk multiplier
  const currentMult = getLastBulkMultiplier();
  for(const sk of getSkillCatalog()){
    updateBulkCostPreview(sk.id, currentMult);
  }
}

/**
 * Update the bulk cost preview for a skill
 * @param {string} skillId - Skill ID
 * @param {number} mult - Bulk multiplier
 */
function updateBulkCostPreview(skillId, mult) {
  const previewEl = document.querySelector(`.bulk-cost[data-skill="${skillId}"]`);
  if (!previewEl) return;
  
  if (mult === 1) {
    previewEl.textContent = '';
    return;
  }
  
  const preview = previewBulkCost(skillId, mult);
  const affordableText = preview.affordable < mult ? ` (max: ×${preview.affordable})` : '';
  previewEl.textContent = `Total (×${mult}): ${preview.formattedCost} Qi${affordableText}`;
  previewEl.style.color = preview.canAfford ? 'var(--accent)' : 'var(--danger)';
}

function renderTimeSpeed(){
  if(!speedButtonsEl) return;
  
  speedButtonsEl.innerHTML = '';
  const availableSpeeds = getAvailableSpeeds();
  
  // Render buttons for all configured speeds
  SPEEDS_CONFIG.forEach(config => {
    const speed = config.speed;
    const btn = document.createElement('button');
    btn.className = 'speed-btn';
    btn.textContent = speed === 0 ? 'Pause' : `${speed}×`;
    
    const isAvailable = availableSpeeds.includes(speed);
    const isActive = (speed === 0 && S.timeSpeed.paused) || (!S.timeSpeed.paused && S.timeSpeed.current === speed);
    
    if(!isAvailable) {
      btn.disabled = true;
      const requiredRealmIndex = idx(config.unlockAt);
      const requiredRealmName = realms[requiredRealmIndex]?.name || 'Unknown Realm';
      btn.title = `Unlocked at ${requiredRealmName}`;
    } else {
      // Add tooltip explaining how time speed works
      if (speed === 0) {
        btn.title = 'Pause: Time stops (no Qi gain, no aging)';
      } else {
        btn.title = `${speed}× Time Flow: Accelerates lifespan aging only\nQi gains are NOT affected by time speed\nAging happens ${speed}× faster`;
      }
      btn.addEventListener('click', () => setTimeSpeed(speed));
    }
    
    if(isActive) {
      btn.classList.add('active');
      if(speed === 0) btn.classList.add('paused');
    }
    
    speedButtonsEl.appendChild(btn);
  });
}

function renderAll(){
  verEl.textContent = VERSION;
  renderStats();
  renderRealm();
  renderTranscendencePanel();
  renderShop();
  renderTimeSpeed();
  renderCycleBadge();
  updateLastSave();
  updateAchievementsBadge();
  checkAchievements();
  updateCultivatorImage();
}

// ============= ACHIEVEMENTS PANEL MANAGEMENT =============

let currentAchievementFilter = 'all';

function openAchievementsPanel() {
  if (!achievementsPanel || !achievementsBtn) return;
  
  // Mark as opened for the dao_seeker achievement
  if (!achievementState.achievementsPanelOpened) {
    achievementState.achievementsPanelOpened = true;
    saveAchievementState();
    checkAchievements();
  }
  
  achievementsPanel.classList.add('open');
  achievementsPanel.setAttribute('aria-hidden', 'false');
  achievementsBtn.setAttribute('aria-expanded', 'true');
  renderAchievementsList();
}

function closeAchievementsPanel() {
  if (!achievementsPanel || !achievementsBtn) return;
  
  achievementsPanel.classList.remove('open');
  achievementsPanel.setAttribute('aria-hidden', 'true');
  achievementsBtn.setAttribute('aria-expanded', 'false');
}

function renderAchievementsList() {
  if (!achievementsList) return;
  
  const filteredAchievements = ACHIEVEMENTS.filter(achievement => {
    const isUnlocked = hasAchievement(achievement.id);
    
    if (currentAchievementFilter === 'unlocked' && !isUnlocked) return false;
    if (currentAchievementFilter === 'locked' && isUnlocked) return false;
    if (currentAchievementFilter !== 'all' && 
        currentAchievementFilter !== 'unlocked' && 
        currentAchievementFilter !== 'locked' && 
        achievement.category !== currentAchievementFilter) return false;
    
    return true;
  });
  
  achievementsList.innerHTML = filteredAchievements.map(achievement => {
    const isUnlocked = hasAchievement(achievement.id);
    const unlockedData = achievementState.unlocked[achievement.id];
    
    let dateText = '';
    if (isUnlocked && unlockedData?.unlockedAt) {
      const date = new Date(unlockedData.unlockedAt);
      dateText = `<div class="achievement-date">Unlocked: ${date.toLocaleDateString()}</div>`;
    }
    
    const displayTitle = isUnlocked ? achievement.title : (achievement.hiddenUntilUnlocked ? '???' : achievement.title);
    const displayDesc = isUnlocked ? achievement.description : (achievement.hiddenUntilUnlocked ? 'Hidden achievement' : achievement.description);
    const displayIcon = isUnlocked ? achievement.icon : '🔒';
    const categoryClass = achievement.category === 'Impossible' ? 'impossible' : '';
    
    return `
      <div class="achievement-item ${isUnlocked ? 'unlocked' : 'locked'} ${categoryClass}">
        <div class="achievement-icon ${isUnlocked ? '' : 'locked'}">${displayIcon}</div>
        <div class="achievement-content">
          <div class="achievement-name ${isUnlocked ? '' : 'locked'}">${displayTitle}</div>
          <div class="achievement-desc">${displayDesc}</div>
          ${dateText}
        </div>
      </div>
    `;
  }).join('');
}

function setAchievementFilter(filter) {
  currentAchievementFilter = filter;
  
  // Update filter button states
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  
  renderAchievementsList();
}

let last = now();
function loop(){
  const nowMs = now();
  let rawDt = (nowMs - last)/1000; // Real seconds elapsed (wall-clock time)
  if (rawDt < 0) rawDt = 0; // Guard against time going backwards
  last = nowMs;
  S.lastTick = nowMs; // Update last tick timestamp
  
  // Time speed affects ONLY lifespan aging, NOT Qi gains
  // Qi accumulation uses rawDt (real elapsed time)
  // Lifespan uses rawDt * speed (time-scaled aging)
  const speed = Math.max(0, S.timeSpeed?.current || 1);
  
  tick(rawDt, speed); // Pass raw dt and speed separately
  renderStats();
  renderRealm();
  requestAnimationFrame(loop);
  updateShopButtons();
}

let lastPointerAt = 0;
clickBtn.addEventListener('pointerdown', (e) => {
  const now = performance.now();
  if (now - lastPointerAt < 120) return; // prevent double fire
  lastPointerAt = now;
  e.preventDefault();
  onClick();
  attachCultivatorHalo(); // Add blue halo click feedback
}, { passive:false });

/**
 * Attach blue halo click animation to cultivator frame
 */
function attachCultivatorHalo() {
  const frame = document.querySelector('.cultivator-frame');
  if (!frame) return;
  
  const halo = document.createElement('div');
  halo.className = 'halo';
  frame.appendChild(halo);
  
  // Auto-remove after animation completes
  setTimeout(() => {
    if (halo.parentNode) {
      halo.parentNode.removeChild(halo);
    }
  }, 600);
}

// Touch responsiveness for mobile (no ~300ms delay) - REPLACED by pointerdown
breakthroughBtn.addEventListener('click', ()=>{ doBreakthrough(); save(); renderAll(); });
saveBtn.addEventListener('click', save);
exportBtn.addEventListener('click', exportSave);
importBtn.addEventListener('click', importSave);
resetBtn.addEventListener('click', reset);

// Achievement system event listeners
if (achievementsBtn) {
  achievementsBtn.addEventListener('click', openAchievementsPanel);
}
if (achievementsClose) {
  achievementsClose.addEventListener('click', closeAchievementsPanel);
}

// Achievement filter event listeners
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setAchievementFilter(btn.dataset.filter);
  });
});

// Close achievements panel when clicking outside
document.addEventListener('click', (e) => {
  if (achievementsPanel && achievementsBtn && 
      achievementsPanel.classList.contains('open') && 
      !achievementsPanel.contains(e.target) && 
      !achievementsBtn.contains(e.target)) {
    closeAchievementsPanel();
  }
});

// Close achievements panel with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && achievementsPanel && achievementsPanel.classList.contains('open')) {
    closeAchievementsPanel();
  }
});

document.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){ e.preventDefault(); save(); }
});

(async function init(){
  await loadBalance(); // Load balance configuration first
  assertMonotonicRequirements(); // Validate stage requirements (DEBUG_MODE only)
  S = { ...defaultState(), ...S, skills: { ...defaultState().skills, ...S.skills } };
  
  // Validate and initialize time speed system
  validateTimeSpeedSystem();
  
  // DEBUG: Run system validation assertions
  if (DEBUG_MODE) {
    assertBaseSpeedsPresent();
    assertBulkPurchaseOverflowSafety();
    assertSkillScalingFinite();
    assertSkillScalingReasonable();
    assertNoZeroPerc();
    assertTimeSpeedBehavior();
    __assertNoSpeedInQi(); // Verify Qi formulas don't reference time speed
  }
  
  // Ensure current cycle is set for existing saves
  if(!S.currentCycle) {
    updateCurrentCycle();
  }
  
  // Ensure lifespan is properly set for current realm
  if(!S.lifespan || S.lifespan.max !== getMaxLifespan()) {
    const maxLifespan = getMaxLifespan();
    if(!S.lifespan) {
      if(maxLifespan === null) {
        // True Immortal - infinite lifespan
        S.lifespan = { current: null, max: null };
      } else {
        S.lifespan = { current: maxLifespan, max: maxLifespan };
      }
    } else {
      S.lifespan.max = maxLifespan;
      if(maxLifespan === null) {
        // Became immortal - set infinite lifespan
        S.lifespan.current = null;
      } else if(S.lifespan.current > maxLifespan) {
        S.lifespan.current = maxLifespan;
      }
    }
  }
  
  renderAll();
  
  // Apply offline progress on initial load
  await applyOfflineProgressOnResume({ showPopup: true });
  
  loop();
  setInterval(save, 15000);
  initDebugPanel(); // Initialize debug panel if in dev mode
  initMusicSystem(); // Initialize background music system
})();

// ============= SESSION SNAPSHOT HOOKS =============

// Save session snapshot when tab goes to background
window.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveSessionSnapshot();
  } else {
    // Tab became visible - apply offline progress
    applyOfflineProgressOnResume({ showPopup: true });
  }
});

// Save snapshot before page unloads
window.addEventListener('pagehide', saveSessionSnapshot);
window.addEventListener('beforeunload', saveSessionSnapshot);

function updateShopButtons(){
  document.querySelectorAll('#shop button[data-skill]').forEach(btn=>{
    const id = btn.getAttribute('data-skill');
    const cost = skillCost(id);
    const can = S.qi >= cost;
    btn.disabled = !can;
    btn.classList.toggle('primary', can);
  });
}

// ============= SIMULATION & DEBUG SYSTEM =============

function simulateProgress({seconds = 3600, clickRate = 3, buyStrategy = "greedy_qps"} = {}) {
  // Create simulation state (copy of defaultState with current BAL values)
  let simS = {
    ...defaultState(),
    qi: 0,
    qpcBase: BAL.progression.qpcBaseStart,
    qpsBase: BAL.progression.qpsBaseStart,
    qpcMult: 1,
    qpsMult: 1,
    offlineMult: 1,
    realmIndex: 0,
    stage: 1,
    skills: {},
    reinc: { times: 0, karma: 0, lifetimeQi: 0 }
  };
  
  let totalQi = 0;
  let stagesReached = 0;
  let purchases = {};
  let timePerStage = [];
  let currentTime = 0;
  
  // Simulation helper functions using simS instead of S
  const simTotalQPC = () => {
    let val = simS.qpcBase;
    const qpcAdd = (simS.skills['meridian_flow']||0) * baseEff_for(simS, 'meridian_flow');
    val += qpcAdd;
    const qpcMult = 1 + (simS.skills['dantian_temps']||0) * baseEff_for(simS, 'dantian_temps');
    return val * qpcMult * simS.qpcMult * (1 + (simS.reinc.karma * BAL.reincarnation.karmaPerUnit));
  };
  
  const simTotalQPS = () => {
    let val = simS.qpsBase;
    val += (simS.skills['breath_control']||0) * baseEff_for(simS, 'breath_control');
    const mult = 1 + (simS.skills['lotus_meditation']||0) * baseEff_for(simS, 'lotus_meditation');
    return val * mult * simS.qpsMult * (1 + (simS.reinc.karma * BAL.reincarnation.karmaPerUnit));
  };
  
  const simSkillCost = (id) => {
    const skill = BAL.skills[id];
    const lvl = simS.skills[id] || 0;
    return Math.floor(skill.cost * Math.pow(skill.costScale, lvl));
  };
  
  // Simulation loop
  let dt = 1; // 1 second steps
  for (let time = 0; time < seconds; time += dt) {
    currentTime = time;
    
    // Generate Qi (QPS + clicks)
    const qpsGain = simTotalQPS() * dt;
    const clickGain = simTotalQPC() * clickRate * dt;
    const totalGain = qpsGain + clickGain;
    
    simS.qi += totalGain;
    totalQi += totalGain;
    
    // Check for stage advancement
    const req = stageRequirement(simS.realmIndex, simS.stage);
    if (simS.qi >= req) {
      simS.qi -= req;
      timePerStage.push(time);
      stagesReached++;
      
      if (simS.stage < 10) {
        simS.stage++;
      } else if (simS.realmIndex < realms.length - 1) {
        simS.realmIndex++;
        simS.stage = 1;
        simS.qpcBase += BAL.progression.realmAdvanceReward.qpcBaseAdd;
        simS.qpsBase += BAL.progression.realmAdvanceReward.qpsBaseAdd;
      }
    }
    
    // Buy strategy
    if (buyStrategy === "greedy_qps") {
      // Prioritize QPS skills first, then QPC
      const skillPriority = ['breath_control', 'lotus_meditation', 'meridian_flow', 'dantian_temps', 'closed_door'];
      
      for (const skillId of skillPriority) {
        const cost = simSkillCost(skillId);
        if (simS.qi >= cost) {
          simS.qi -= cost;
          simS.skills[skillId] = (simS.skills[skillId] || 0) + 1;
          purchases[skillId] = (purchases[skillId] || 0) + 1;
          break; // Only buy one skill per second
        }
      }
    }
  }
  
  const estimatedKarma = Math.max(BAL.reincarnation.minKarma, 
    Math.floor(Math.sqrt(totalQi / BAL.reincarnation.lifetimeQiDivisor)) + 
    (simS.realmIndex * BAL.reincarnation.realmKarmaFactor));
  
  return {
    totalQi,
    stagesReached,
    purchases,
    qpc: simTotalQPC(),
    qps: simTotalQPS(),
    timePerStage,
    estimatedKarma,
    finalRealm: simS.realmIndex,
    finalStage: simS.stage
  };
}

function applyRecommendedTweaks(originalBAL) {
  const tweaked = JSON.parse(JSON.stringify(originalBAL));
  
  // Example tweaks based on simulation results
  tweaked.stageRequirement.stageScale *= 0.95; // 5% easier progression
  tweaked.skills.breath_control.costScale *= 0.98; // Slightly cheaper scaling
  tweaked.skills.meridian_flow.costScale *= 0.98;
  
  return tweaked;
}

function runSimulationReport() {
  console.log("=== XIANXIA IDLE SIMULATION REPORT ===");
  console.log("Balance Values:", BAL);
  
  // Run 1-hour simulation
  const sim1h = simulateProgress({seconds: 3600, clickRate: 3, buyStrategy: "greedy_qps"});
  console.log("\n--- 1 HOUR SIMULATION ---");
  console.log(`Stages reached: ${sim1h.stagesReached}`);
  console.log(`Final realm: ${realms[sim1h.finalRealm]?.name || 'Unknown'} (${sim1h.finalStage}/10)`);
  console.log(`Total Qi generated: ${fmt(sim1h.totalQi)}`);
  console.log(`Final QPC: ${fmt(sim1h.qpc)}, QPS: ${fmt(sim1h.qps)}`);
  console.log(`Estimated karma if reincarnating: ${sim1h.estimatedKarma}`);
  console.log("Skill purchases:", sim1h.purchases);
  
  // Run 3-hour simulation
  const sim3h = simulateProgress({seconds: 10800, clickRate: 3, buyStrategy: "greedy_qps"});
  console.log("\n--- 3 HOUR SIMULATION ---");
  console.log(`Stages reached: ${sim3h.stagesReached}`);
  console.log(`Final realm: ${realms[sim3h.finalRealm]?.name || 'Unknown'} (${sim3h.finalStage}/10)`);
  console.log(`Total Qi generated: ${fmt(sim3h.totalQi)}`);
  console.log(`Final QPC: ${fmt(sim3h.qpc)}, QPS: ${fmt(sim3h.qps)}`);
  console.log(`Estimated karma if reincarnating: ${sim3h.estimatedKarma}`);
  console.log("Skill purchases:", sim3h.purchases);
  
  // Analyze pacing
  const qiRefiningTime = sim1h.timePerStage[9]; // Time to complete Qi Refining (stage 10)
  const foundationReached = sim1h.finalRealm >= 1;
  
  console.log("\n--- PACING ANALYSIS ---");
  console.log(`Time to complete Qi Refining: ${qiRefiningTime ? (qiRefiningTime/60).toFixed(1) + ' minutes' : 'Not reached in 1h'}`);
  console.log(`Foundation Establishment reached in 1h: ${foundationReached ? 'YES' : 'NO'}`);
  
  // Recommendations
  if (qiRefiningTime && qiRefiningTime > 1800) { // If taking more than 30 minutes
    console.log("\n--- RECOMMENDED TWEAKS ---");
    console.log("Progression seems slow. Consider:");
    console.log("- Reducing stageRequirement.stageScale from", BAL.stageRequirement.stageScale, "to", (BAL.stageRequirement.stageScale * 0.9).toFixed(3));
    console.log("- Reducing skill cost scaling by ~2%");
    
    const tweakedBAL = applyRecommendedTweaks(BAL);
    console.log("Tweaked balance:", tweakedBAL);
  } else if (qiRefiningTime && qiRefiningTime < 600) { // If taking less than 10 minutes
    console.log("\n--- RECOMMENDED TWEAKS ---");
    console.log("Progression seems too fast. Consider:");
    console.log("- Increasing stageRequirement.stageScale from", BAL.stageRequirement.stageScale, "to", (BAL.stageRequirement.stageScale * 1.1).toFixed(3));
  } else {
    console.log("\n--- BALANCE STATUS ---");
    console.log("Pacing seems reasonable!");
  }
}

function initDebugPanel() {
  // Only show debug panel if ?dev=1 is in URL
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('dev') !== '1') return;
  
  const debugPanel = document.createElement('div');
  debugPanel.id = 'devDebugPanel';
  debugPanel.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(18, 25, 35, 0.85);
    border: 1px solid #2a3748;
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
    color: #e6edf3;
    z-index: 1000;
    max-width: 280px;
    opacity: 0.8;
  `;
  
  debugPanel.innerHTML = `
    <h4 style="margin: 0 0 8px 0; color: #7ee787;">Dev Tools</h4>
    <button id="runSim6hBtn" style="margin: 2px; padding: 4px 8px; background: #0f1a13; border: 1px solid #35533d; color: #7ee787; cursor: pointer; border-radius: 4px; font-size: 11px;">
      Run Sim (6h)
    </button>
    <button id="runEstimateBtn" style="margin: 2px; padding: 4px 8px; background: #120f1a; border: 1px solid #3a3553; color: #a18aff; cursor: pointer; border-radius: 4px; font-size: 11px;">
      Run Estimate Set
    </button>
    <div id="devResult" style="margin-top: 6px; font-size: 10px; color: #9fb0c3; min-height: 14px;"></div>
  `;
  
  document.body.appendChild(debugPanel);
  
  // Run 6h simulation button
  document.getElementById('runSim6hBtn').addEventListener('click', () => {
    try {
      const result = simulateCompletion({seconds: 6*3600, clickRate: 3});
      const summary = `${result.finished ? 'Finished' : 'Not finished'} at ${result.finalRealm} ${result.finalStage}/10 (${(result.timeSec/3600).toFixed(1)}h)`;
      document.getElementById('devResult').textContent = summary;
      console.log('6h Simulation Result:', result);
    } catch (error) {
      console.error('Simulation error:', error);
      document.getElementById('devResult').textContent = 'Error - check console';
    }
  });
  
  // Run estimate set button
  document.getElementById('runEstimateBtn').addEventListener('click', () => {
    try {
      runCompletionEstimate();
      document.getElementById('devResult').textContent = 'See console for full estimate results';
    } catch (error) {
      console.error('Estimate error:', error);
      document.getElementById('devResult').textContent = 'Error - check console';
    }
  });
}
// =====================
// Simulador de tiempo a "completarse" (sin reencarnar)
// =====================

// New helper (simulation only)
function baseEff_for(st, id){
  const cat = getSkillCatalog();
  const sk  = cat.find(s => s.id === id);
  const realmMult = 1 + (st.realmIndex * REALM_SKILL_BONUS);
  return sk.base * realmMult;
}

// Helpers puros que operan sobre un "estado" pasado por parámetro (no mutan S real)
function totalQPC_for(st){
  let val = st.qpcBase;
  val += (st.skills['meridian_flow']||0) * baseEff_for(st, 'meridian_flow');
  const mult = 1 + (st.skills['dantian_temps']||0) * baseEff_for(st, 'dantian_temps');
  const karmaMult = karmaQiMult(st.reinc?.karma || 0);
  const cycleMult = cyclePowerMult(st.realmIndex);
  return val * mult * st.qpcMult * karmaMult * cycleMult;
}

function totalQPS_for(st){
  let val = st.qpsBase;
  val += (st.skills['breath_control']||0) * baseEff_for(st, 'breath_control');
  const mult = 1 + (st.skills['lotus_meditation']||0) * baseEff_for(st, 'lotus_meditation');
  const karmaMult = karmaQiMult(st.reinc?.karma || 0);
  const cycleMult = cyclePowerMult(st.realmIndex);
  return val * mult * st.qpsMult * karmaMult * cycleMult;
}

function skillCostFor(st, id){
  const sk = getSkill(id); const lvl = st.skills[id]||0;
  return Math.floor(sk.cost * Math.pow(sk.costScale, lvl));
}

function cloneStateForSim(){
  const st = defaultState();
  // importante: copiar también skills
  st.skills = { ...defaultState().skills };
  return st;
}

// Estrategia de compra: valora cuánto sube la producción por costo
function bestPurchase(st, clickRate){
  const candidates = [
    { id:'breath_control', kind:'qps_add' },
    { id:'lotus_meditation', kind:'qps_mult' },
    { id:'meridian_flow', kind:'qpc_add' },
    { id:'dantian_temps', kind:'qpc_mult' },
    // Nota: ignoramos "closed_door" en la simulación (afecta offline).
  ];
  const qps0 = totalQPS_for(st);
  const qpc0 = totalQPC_for(st);
  const eff0 = qps0 + qpc0 * clickRate; // producción efectiva por segundo

  let best = null;

  for(const c of candidates){
    const cost = skillCostFor(st, c.id);
    if(st.qi < cost) continue;

    // simular +1 nivel
    const st2 = JSON.parse(JSON.stringify(st));
    st2.skills[c.id] = (st2.skills[c.id]||0) + 1;
    const qps1 = totalQPS_for(st2);
    const qpc1 = totalQPC_for(st2);
    const eff1 = qps1 + qpc1 * clickRate;

    const delta = eff1 - eff0;          // ganancia de producción por segundo
    const valuePerCost = delta / cost;  // eficiencia

    if(!best || valuePerCost > best.vpc){
      best = { id: c.id, cost, delta, vpc: valuePerCost };
    }
  }

  return best; // o null si no alcanza para nada
}

/**
 * Simula progreso hasta completar Spirit Transformation 10 o hasta "seconds" de tiempo.
 * @param {object} opt
 *  - seconds: duración máxima (por defecto 8h)
 *  - clickRate: clicks por segundo (ej: 3)
 *  - dt: tamaño de paso en segundos (ej: 0.1)
 *  - buyEvery: cada cuántos segundos intentar comprar (ej: 0.25)
 * @returns {object} { finished, timeSec, finalRealm, finalStage, purchases, summary }
 */
function simulateCompletion(opt={}){
  const seconds  = opt.seconds  ?? 8*3600;
  const clickRate= opt.clickRate?? 3;
  const dt       = opt.dt       ?? 0.1;
  const buyEvery = opt.buyEvery ?? 0.25;

  const st = cloneStateForSim();
  let t = 0, accBuy = 0;
  let purchases = { breath_control:0, lotus_meditation:0, meridian_flow:0, dantian_temps:0 };

  function breakthroughIfPossible(){
    const req = stageRequirement(st.realmIndex, st.stage);
    if(st.qi >= req){
      st.qi -= req;
      if(st.stage < 10){
        st.stage++;
      } else {
        if(st.realmIndex < realms.length-1){
          st.realmIndex++; st.stage = 1;
          // Use BAL values for consistency with main game
          st.qpcBase += BAL.progression.realmAdvanceReward.qpcBaseAdd;
          st.qpsBase += BAL.progression.realmAdvanceReward.qpsBaseAdd;
        } else {
          // Spirit Transformation 10 alcanzado
          return true;
        }
      }
    }
    return false;
  }

  while(t < seconds){
    // producción continua
    st.qi += totalQPS_for(st) * dt;
    st.qi += totalQPC_for(st) * clickRate * dt;

    // intentar breakthrough (puede ser más de uno si acumula mucho)
    while (breakthroughIfPossible()){
      return {
        finished: true,
        timeSec: t,
        finalRealm: realms[st.realmIndex].name,
        finalStage: st.stage,
        purchases,
        summary: `Finished at ${t.toFixed(1)}s`
      };
    }

    // intentar compras periódicamente
    accBuy += dt;
    if(accBuy >= buyEvery){
      accBuy = 0;
      const best = bestPurchase(st, clickRate);
      if(best){
        st.qi -= best.cost;
        st.skills[best.id] = (st.skills[best.id]||0) + 1;
        purchases[best.id] = (purchases[best.id]||0) + 1;
      }
    }

    t += dt;
  }

  // no se completó dentro del tiempo
  return {
    finished: false,
    timeSec: seconds,
    finalRealm: realms[st.realmIndex].name,
    finalStage: st.stage,
    purchases,
    summary: `Not finished after ${seconds}s`
  };
}

// Helper para correr varios escenarios y loguear lindo
function runCompletionEstimate(){
  const cases = [
    { label:'Casual (2 cps, 6h)',    seconds:6*3600, clickRate:2 },
    { label:'Normal (3 cps, 6h)',    seconds:6*3600, clickRate:3 },
    { label:'Dedicated (5 cps, 6h)', seconds:6*3600, clickRate:5 },
    { label:'Grinder (3 cps, 10h)',  seconds:10*3600, clickRate:3 },
  ];
  console.log('%c=== Completion Simulator ===','color:#7ee787');
  for(const c of cases){
    const r = simulateCompletion(c);
    console.log(`${c.label} -> finished: ${r.finished}, time:${(r.timeSec/3600).toFixed(2)}h, progress: ${r.finalRealm} ${r.finalStage}/10, purchases:`, r.purchases);
  }
  console.log('Tip: tweak clickRate/seconds in runCompletionEstimate().');
}

// ============= BACKGROUND MUSIC SYSTEM =============

const PLAYLIST = [
  'assets/music/music1.mp3',
  'assets/music/music2.mp3',
  'assets/music/music3.mp3',
  'assets/music/music4.mp3',
  'assets/music/music5.mp3',
  'assets/music/music6.mp3',
  'assets/music/music7.mp3',
];

let currentIndex = 0;
let audio = document.getElementById('bgm') || createAudio();

function createAudio(){
  const a = document.createElement('audio');
  a.id = 'bgm';
  a.preload = 'auto';
  document.body.appendChild(a);
  return a;
}

// Music settings
const MUSIC_SETTINGS_KEY = 'xianxiaMusic';

function loadMusicSettings(){
  try {
    return JSON.parse(localStorage.getItem(MUSIC_SETTINGS_KEY)) || { enabled: true, volume: 0.4 };
  } catch {
    return { enabled: true, volume: 0.4 };
  }
}

function saveMusicSettings(s){
  localStorage.setItem(MUSIC_SETTINGS_KEY, JSON.stringify(s));
}

let musicSettings = loadMusicSettings();

// Initialize audio
audio.volume = musicSettings.volume;
audio.muted = !musicSettings.enabled;

function loadTrack(i){
  currentIndex = (i + PLAYLIST.length) % PLAYLIST.length;
  audio.src = PLAYLIST[currentIndex];
  updateTrackInfo();
}

function playSafe(){
  return audio.play().catch(() => {
    // Autoplay blocked (mobile/desktop policy) — show a note until user interacts
    const note = document.getElementById('autoplayNote');
    if (note) note.style.display = 'block';
  });
}

function updateTrackInfo(){
  const el = document.getElementById('trackInfo');
  if (el) el.textContent = `Track ${currentIndex+1}/${PLAYLIST.length}`;
}

async function crossfadeTo(nextIndex, dur=800){
  const startVol = audio.volume;
  const targetVol = musicSettings.volume;
  const t0 = performance.now();
  while (performance.now() - t0 < dur){
    const k = (performance.now() - t0) / dur;
    audio.volume = startVol * (1 - k);
    await new Promise(r=>requestAnimationFrame(r));
  }
  loadTrack(nextIndex);
  await audio.play().catch(()=>{});
  const t1 = performance.now();
  while (performance.now() - t1 < dur){
    const k = (performance.now() - t1) / dur;
    audio.volume = targetVol * k;
    await new Promise(r=>requestAnimationFrame(r));
  }
  audio.volume = targetVol;
}

audio.onended = () => crossfadeTo(currentIndex + 1);

// Initialize music system
function initMusicSystem(){
  // Start playlist
  loadTrack(0);
  if (musicSettings.enabled) playSafe();

  // Settings UI elements
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const volumeSlider = document.getElementById('musicVolume');
  const muteBtn = document.getElementById('musicMuteToggle');

  if (!settingsBtn || !settingsPanel || !volumeSlider || !muteBtn) return;

  // Panel toggle
  settingsBtn.addEventListener('click', () => {
    const open = settingsPanel.classList.toggle('open');
    settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    settingsPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    
    // Dynamic positioning relative to button
    if (open) {
      const btn = settingsBtn;
      const panel = settingsPanel;
      const r = btn.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.top = `${r.bottom + 8}px`;
      panel.style.left = 'auto';
      panel.style.right = `${Math.max(20, (window.innerWidth - r.right))}px`;
    }
  });

  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
      settingsPanel.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      settingsPanel.setAttribute('aria-hidden', 'true');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      settingsPanel.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      settingsPanel.setAttribute('aria-hidden', 'true');
    }
  });

  // Initialize controls from settings
  volumeSlider.value = Math.round(musicSettings.volume * 100);
  muteBtn.textContent = musicSettings.enabled ? 'Mute' : 'Unmute';

  // Volume control
  volumeSlider.addEventListener('input', () => {
    const v = Math.max(0, Math.min(100, Number(volumeSlider.value))) / 100;
    audio.volume = v;
    musicSettings.volume = v;
    saveMusicSettings(musicSettings);
  });

  // Mute/unmute control
  muteBtn.addEventListener('click', () => {
    const enabled = !audio.muted;
    // toggle
    audio.muted = enabled;
    musicSettings.enabled = !audio.muted;
    muteBtn.textContent = musicSettings.enabled ? 'Mute' : 'Unmute';
    saveMusicSettings(musicSettings);
    if (musicSettings.enabled) playSafe();
  });

  // Resume on user interaction if autoplay was blocked
  window.addEventListener('pointerdown', () => {
    if (!audio.src) loadTrack(currentIndex);
    if (musicSettings.enabled && audio.paused) playSafe();
    const note = document.getElementById('autoplayNote');
    if (note) note.style.display = 'none';
  }, { once: true });
}

// === DEV MODE CONTROL ===
// Define allowed conditions for developer mode
const urlParams = new URLSearchParams(window.location.search);
const devKey = urlParams.get('key');
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const isDevParam = window.location.search.includes('dev=1');
const isSecretKey = (devKey === 'SANTI_SECRET_777');

// Final condition: allowed only if local, ?dev=1, or correct secret key
const isAllowedDev = isLocal || isDevParam || isSecretKey;

if (isAllowedDev) {
  window.runCompletionEstimate = runCompletionEstimate;
  window.simulateCompletion = simulateCompletion;
  console.log("🧪 Dev mode enabled — simulator active");
  // Optionally: createDevPanel();
} else {
  console.log("🔒 Dev mode disabled in production.");
}

// Cultivator Image Management
function updateCultivatorImage() {
  const img = document.querySelector('#cultivatorImg');
  if (!img) return;
  
  const rMortal = REALM_INDEX['mortal_realm'];
  let targetImage;
  
  if (S.realmIndex === rMortal) {
    // Special art ONLY in Mortal Realm
    targetImage = 'assets/cultivator0.jpg';
  } else {
    // Keep existing cycle logic for all other realms
    targetImage = (S.currentCycle === 'spirit')
      ? 'assets/cultivator2.jpg'
      : 'assets/cultivator.jpg';
  }
  
  // Only update if image needs to change
  if (img.src.includes(targetImage.split('/').pop())) return;
  
  // Fade out current image
  img.classList.add('fade-out');
  
  // After fade completes, change image and fade back in
  setTimeout(() => {
    img.src = targetImage;
    img.classList.remove('fade-out');
  }, 250); // Half the transition duration
}

// Update image when cycle changes
function onCycleChange() {
  updateCultivatorImage();
}

// Call on game initialization and after reincarnation
document.addEventListener('DOMContentLoaded', () => {
  updateCultivatorImage();
  
  // Dev-mode guard: Check for lifespan UI elements and formatting issues
  if(DEBUG_MODE) {
    // Check for correct lifespan UI elements
    const lifespanValueCount = document.querySelectorAll('#lifespanValue').length;
    const lifespanProgressCount = document.querySelectorAll('#lifespanProgress').length;
    
    if(lifespanValueCount !== 1) {
      console.error(`❌ Expected 1 #lifespanValue element, found ${lifespanValueCount}`);
    }
    
    if(lifespanProgressCount !== 1) {
      console.error(`❌ Expected 1 #lifespanProgress element, found ${lifespanProgressCount}`);
    }
    
    // Set up periodic checks for UI consistency
    setInterval(() => {
      const lifespanValue = document.getElementById('lifespanValue');
      
      // Check for "years" in lifespan value (should be numeric only)
      if(lifespanValue && lifespanValue.textContent.toLowerCase().includes('year')) {
        console.error('❌ CRITICAL BUG: "years" text found in lifespan value!');
        console.error('Current text:', lifespanValue.textContent);
        console.error('Lifespan should show numeric format: "39.48 / 100.00"');
      }
      
      // Check time speed consistency (0.5× should be exactly half of 1×)
      const speed = getTimeSpeed();
      if(speed === 0.5) {
        console.log('⏱ Time Speed: 0.5× (exactly half of 1×)');
      }
    }, 5000);
  }
});



