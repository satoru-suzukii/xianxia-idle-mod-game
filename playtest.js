const fs = require('fs');
const path = require('path');

const balancePath = path.join(__dirname, 'balance.json');
const BAL = JSON.parse(fs.readFileSync(balancePath, 'utf8'));

const realms = [
  { id:'mortal_realm', name:'Mortal Realm' },
  { id:'qi_refining', name:'Qi Refining' },
  { id:'foundation_establishment', name:'Foundation Establishment' },
  { id:'golden_core', name:'Golden Core' },
  { id:'nascent_soul', name:'Nascent Soul' },
  { id:'spirit_transformation', name:'Spirit Transformation' },
  { id:'void_refining', name:'Void Refining' },
  { id:'body_integration', name:'Body Integration' },
  { id:'mahayana', name:'Mahayana' },
  { id:'tribulation_transcendence', name:'Tribulation Transcendence' },
  { id:'true_immortal', name:'True Immortal' },
];
const REALM_INDEX = Object.fromEntries(realms.map((r, i) => [r.id, i]));

const SKILL_SCALING = {
  realmMaxMult: 3.0,
  realmK: 0.60,
  karmaLogCoeff: 0.30,
  karmaMaxMult: 2.5,
  mortalCycleBoost: 1.0,
  spiritCycleBoost: 5.0,
};

const CROSS_REALM_JUMP = 1.25;
let MIN_REALM_SCALE = null;
let EFFECTIVE_REALM_SCALE = null;

function numEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function applyOverrides() {
  BAL.stageRequirement.realmBase = numEnv('REALM_BASE', BAL.stageRequirement.realmBase);
  BAL.stageRequirement.realmBaseScale = numEnv('REALM_BASE_SCALE', BAL.stageRequirement.realmBaseScale);
  BAL.stageRequirement.stageScale = numEnv('STAGE_SCALE', BAL.stageRequirement.stageScale);
  BAL.progression.realmAdvanceReward.qpcBaseAdd = numEnv('QPC_ADD', BAL.progression.realmAdvanceReward.qpcBaseAdd);
  BAL.progression.realmAdvanceReward.qpsBaseAdd = numEnv('QPS_ADD', BAL.progression.realmAdvanceReward.qpsBaseAdd);
  BAL.reincarnation.realmKarmaFactor = numEnv('KARMA_REALM_FACTOR', BAL.reincarnation.realmKarmaFactor);
  BAL.reincarnation.lifetimeQiDivisor = numEnv('KARMA_DIV', BAL.reincarnation.lifetimeQiDivisor);

  const ranksCap = numEnv('RANKS_CAP', NaN);
  if (Number.isFinite(ranksCap) && ranksCap > 0) {
    Object.entries(BAL.skills).forEach(([id, sk]) => {
      if (!sk.oneTime) sk.ranksPerRealm = Math.floor(ranksCap);
    });
  }
}

applyOverrides();

function resetReqCache() {
  MIN_REALM_SCALE = null;
  EFFECTIVE_REALM_SCALE = null;
}

function minTierPctByRealm(realmIndex) {
  const floor = 0.00015 + 0.001 * (1 - Math.exp(-0.35 * Math.max(0, realmIndex)));
  return Math.min(0.01, floor);
}

function maxTierPctByRealm(realmIndex) {
  const cap = 0.02 + 0.05 * (1 - Math.exp(-0.25 * Math.max(0, realmIndex)));
  return Math.min(0.06, cap);
}

function karmaQiMult(karma) {
  return 1 + 1.2 * (1 - Math.exp(-0.04 * karma));
}

function karmaStageMult(karma) {
  return 1 + 0.6 * (1 - Math.exp(-0.03 * karma));
}

function karmaStageBonus(karma) {
  return 1.0 / karmaStageMult(karma);
}

function computeKarmaGain(st) {
  const safeLifetimeQi = Number.isFinite(st.reinc.lifetimeQi) ? st.reinc.lifetimeQi : 0;
  const safeDivisor = Number.isFinite(BAL.reincarnation.lifetimeQiDivisor) ? BAL.reincarnation.lifetimeQiDivisor : 1000;
  const base = Math.floor(Math.sqrt(Math.max(0, safeLifetimeQi / safeDivisor)));
  const realmBonus = st.realmIndex * BAL.reincarnation.realmKarmaFactor;
  const cycleMultiplier = st.currentCycle === 'spirit' ? 2 : 1;
  const total = (base + realmBonus) * cycleMultiplier;
  return Math.max(BAL.reincarnation.minKarma, total);
}

function cycleForRealm(realmIndex) {
  const mortal = BAL.cycleDefinitions?.mortal?.realms || [];
  const spirit = BAL.cycleDefinitions?.spirit?.realms || [];
  if (spirit.includes(realmIndex)) return 'spirit';
  if (mortal.includes(realmIndex)) return 'mortal';
  return realmIndex >= REALM_INDEX.void_refining ? 'spirit' : 'mortal';
}

function cyclePowerMult(realmIndex) {
  const mortalRealms = BAL.cycleDefinitions?.mortal?.realms || [];
  const spiritRealms = BAL.cycleDefinitions?.spirit?.realms || [];

  if (mortalRealms.includes(realmIndex)) {
    const idxInCycle = mortalRealms.indexOf(realmIndex);
    const bonus = BAL.cycleDefinitions?.mortal?.realmBonus ?? 0.25;
    return 1 + (bonus * idxInCycle);
  }
  if (spiritRealms.includes(realmIndex)) {
    const idxInCycle = spiritRealms.indexOf(realmIndex);
    const bonus = BAL.cycleDefinitions?.spirit?.realmBonus ?? 0.50;
    return 1 + (bonus * idxInCycle);
  }
  return 1;
}

function skillRealmScale(realmIndex) {
  const { realmMaxMult, realmK } = SKILL_SCALING;
  const scale = 1 + realmMaxMult * (1 - Math.exp(-realmK * Math.max(0, realmIndex)));
  return Math.min(1 + realmMaxMult, Math.max(1, scale));
}

function skillKarmaBoost(karma) {
  const { karmaLogCoeff, karmaMaxMult } = SKILL_SCALING;
  const mult = 1 + Math.log10(Math.max(1, karma) + 1) * karmaLogCoeff;
  return Math.min(1 + karmaMaxMult, Math.max(1, mult));
}

function effectiveSkillBase(st, skillId) {
  const skill = BAL.skills[skillId];
  const base = skill?.base ?? 0;
  if (base <= 0) return 0;

  const realmMult = skillRealmScale(st.realmIndex);
  const karmaMult = skillKarmaBoost(st.reinc.karma || 0);
  const cycleMult = st.currentCycle === 'spirit' ? SKILL_SCALING.spiritCycleBoost : SKILL_SCALING.mortalCycleBoost;

  const scaled = base * realmMult * karmaMult * cycleMult;
  return Number.isFinite(scaled) ? Math.min(1e150, Math.max(0, scaled)) : 0;
}

function currentRealmRanks(st, skillId) {
  const skill = st.skills[skillId];
  if (!skill || skill.purchasedOneTime) return 0;
  return skill.perRealm?.[st.realmIndex] || 0;
}

function addRealmRank(st, skillId, n) {
  let skill = st.skills[skillId];
  if (!skill) {
    skill = st.skills[skillId] = { total: 0, perRealm: {} };
  }
  const cur = currentRealmRanks(st, skillId);
  skill.perRealm[st.realmIndex] = cur + n;
  skill.total += n;
}

function isTechniquePurchased(st, skillId) {
  return !!st.skills[skillId]?.purchasedOneTime;
}

function purchaseTechnique(st, skillId) {
  st.skills[skillId] = { purchasedOneTime: true, total: 1, perRealm: {} };
}

function totalQPC(st) {
  let add = st.qpcBase;
  let mult = 1;

  const ranksM = currentRealmRanks(st, 'meridian_flow');
  if (ranksM > 0) {
    const effBase = effectiveSkillBase(st, 'meridian_flow');
    const baseline = st.qpcBase * (BAL.realmBaselines?.qpcFlatPerRank ?? 0.25);
    add += ranksM * baseline * effBase;
  }

  const ranksD = currentRealmRanks(st, 'dantian_temps');
  if (ranksD > 0) {
    const sk = BAL.skills['dantian_temps'];
    const basePctPerRank = sk?.base ?? 0.008;
    const capPct = sk?.capPctPerRealm ?? 0.12;
    const minPct = minTierPctByRealm(st.realmIndex);
    const maxPct = maxTierPctByRealm(st.realmIndex);
    const pctPerRank = Math.max(minPct, Math.min(maxPct, basePctPerRank));
    const effBase = effectiveSkillBase(st, 'dantian_temps');
    const scaledCap = Math.min(capPct * Math.sqrt(effBase), 2.0);
    const totalPct = Math.min(ranksD * pctPerRank, scaledCap);
    mult *= (1 + totalPct);
  }

  if (isTechniquePurchased(st, 'void_convergence')) {
    const sk = BAL.skills['void_convergence'];
    mult *= (1 + (sk?.value ?? 0.12));
  }

  return add * mult * st.qpcMult * karmaQiMult(st.reinc.karma) * cyclePowerMult(st.realmIndex);
}

function totalQPS(st) {
  if (st.realmIndex === 0) return 0;

  let add = st.qpsBase;
  let mult = 1;

  const ranksB = currentRealmRanks(st, 'breath_control');
  if (ranksB > 0) {
    const effBase = effectiveSkillBase(st, 'breath_control');
    const baseline = st.qpsBase * (BAL.realmBaselines?.qpsFlatPerRank ?? 0.15);
    add += ranksB * baseline * effBase;
  }

  const ranksL = currentRealmRanks(st, 'lotus_meditation');
  if (ranksL > 0) {
    const sk = BAL.skills['lotus_meditation'];
    const basePctPerRank = sk?.base ?? 0.008;
    const capPct = sk?.capPctPerRealm ?? 0.12;
    const minPct = minTierPctByRealm(st.realmIndex);
    const maxPct = maxTierPctByRealm(st.realmIndex);
    const pctPerRank = Math.max(minPct, Math.min(maxPct, basePctPerRank));
    const effBase = effectiveSkillBase(st, 'lotus_meditation');
    const scaledCap = Math.min(capPct * Math.sqrt(effBase), 2.0);
    const totalPct = Math.min(ranksL * pctPerRank, scaledCap);
    mult *= (1 + totalPct);
  }

  if (isTechniquePurchased(st, 'celestial_resonance')) {
    const sk = BAL.skills['celestial_resonance'];
    mult *= (1 + (sk?.value ?? 0.12));
  }

  return add * mult * st.qpsMult * karmaQiMult(st.reinc.karma) * cyclePowerMult(st.realmIndex);
}

function baseRequirementFor(realmIndex, stage) {
  if (realmIndex === 0) return stage * 10;

  if (EFFECTIVE_REALM_SCALE === null) {
    const stageScale = BAL.stageRequirement.stageScale;
    MIN_REALM_SCALE = Math.pow(stageScale, 9);
    EFFECTIVE_REALM_SCALE = Math.max(BAL.stageRequirement.realmBaseScale, MIN_REALM_SCALE);
  }

  const realmBase = BAL.stageRequirement.realmBase * Math.pow(EFFECTIVE_REALM_SCALE, realmIndex);
  const stageScale = Math.pow(BAL.stageRequirement.stageScale, stage - 1);
  return Math.floor(realmBase * stageScale);
}

function stageRequirement(realmIndex, stage, karma = 0) {
  const baseReq = baseRequirementFor(realmIndex, stage);
  const kr = karmaStageBonus(karma);
  let req = Math.floor(baseReq * kr);

  if (realmIndex > 0 && stage === 1) {
    const prevStage10 = Math.floor(baseRequirementFor(realmIndex - 1, 10) * kr);
    const minRequired = Math.floor(prevStage10 * CROSS_REALM_JUMP);
    req = Math.max(req, minRequired);
  }

  return req;
}

function defaultState() {
  return {
    qi: 0,
    qpcBase: BAL.progression.qpcBaseStart,
    qpsBase: BAL.progression.qpsBaseStart,
    qpcMult: 1,
    qpsMult: 1,
    realmIndex: 0,
    stage: 1,
    skills: {},
    currentCycle: 'mortal',
    flags: {
      unlockedBeyondSpirit: false,
      hasUnlockedSpiritCycle: false,
      hasCompletedMandatoryST10: false,
      canManualReincarnate: false
    },
    reinc: { times: 0, karma: 0, lifetimeQi: 0 }
  };
}

function canBuySkillInCurrentCycle(st, skillId) {
  const sk = BAL.skills[skillId];
  if (!sk) return false;
  if (!sk.unlockAtCycle) return true;
  return sk.unlockAtCycle === st.currentCycle;
}

function skillCost(st, skillId) {
  const sk = BAL.skills[skillId];
  if (!sk) return Number.POSITIVE_INFINITY;
  if (sk.oneTime) return sk.cost;
  const lvl = currentRealmRanks(st, skillId);
  return Math.floor(sk.cost * Math.pow(sk.costScale, lvl));
}

function isAtRankCap(st, skillId) {
  const sk = BAL.skills[skillId];
  if (!sk || sk.oneTime) return false;
  return currentRealmRanks(st, skillId) >= (sk.ranksPerRealm ?? 0);
}

function applyPurchase(st, skillId) {
  const sk = BAL.skills[skillId];
  if (!sk) return false;

  if (sk.oneTime) {
    if (isTechniquePurchased(st, skillId)) return false;
    if (st.qi < sk.cost) return false;
    st.qi -= sk.cost;
    purchaseTechnique(st, skillId);
    return true;
  }

  if (isAtRankCap(st, skillId)) return false;
  const cost = skillCost(st, skillId);
  if (st.qi < cost) return false;
  st.qi -= cost;
  addRealmRank(st, skillId, 1);
  return true;
}

function productionPerSec(st, clickRate) {
  return totalQPS(st) + totalQPC(st) * clickRate;
}

function findBestPurchase(st, clickRate) {
  const ids = Object.keys(BAL.skills).filter(id => canBuySkillInCurrentCycle(st, id));
  const baseProd = productionPerSec(st, clickRate);
  let best = null;

  for (const id of ids) {
    const sk = BAL.skills[id];
    if (!sk) continue;

    if (sk.oneTime && isTechniquePurchased(st, id)) continue;
    if (!sk.oneTime && isAtRankCap(st, id)) continue;

    const cost = skillCost(st, id);
    if (!Number.isFinite(cost) || cost <= 0 || st.qi < cost) continue;

    const probe = JSON.parse(JSON.stringify(st));
    if (!applyPurchase(probe, id)) continue;

    const gain = productionPerSec(probe, clickRate) - baseProd;
    const vpc = gain / cost;

    if (!best || vpc > best.vpc) best = { id, vpc, cost, gain };
  }

  return best;
}

function doMandatoryReincarnation(st) {
  const gain = computeKarmaGain(st);
  const newKarma = st.reinc.karma + gain;
  const newTimes = st.reinc.times + 1;

  const keepFlags = { ...st.flags };
  keepFlags.hasCompletedMandatoryST10 = true;
  keepFlags.hasUnlockedSpiritCycle = true;
  keepFlags.canManualReincarnate = true;
  keepFlags.unlockedBeyondSpirit = true;

  const fresh = defaultState();
  st.qi = fresh.qi;
  st.qpcBase = fresh.qpcBase;
  st.qpsBase = fresh.qpsBase;
  st.qpcMult = fresh.qpcMult;
  st.qpsMult = fresh.qpsMult;
  st.realmIndex = fresh.realmIndex;
  st.stage = fresh.stage;
  st.skills = fresh.skills;
  st.currentCycle = fresh.currentCycle;
  st.flags = keepFlags;
  st.reinc = { times: newTimes, karma: newKarma, lifetimeQi: 0 };
}

function doBreakthrough(st) {
  const req = stageRequirement(st.realmIndex, st.stage, st.reinc.karma || 0);
  if (st.qi < req) return false;

  st.qi -= req;

  if (st.stage < 10) {
    st.stage += 1;
    return false;
  }

  const stIndex = REALM_INDEX.spirit_transformation;
  if (st.realmIndex === stIndex && !st.flags.unlockedBeyondSpirit) {
    doMandatoryReincarnation(st);
    return false;
  }

  if (st.realmIndex >= realms.length - 1) {
    return true;
  }

  st.realmIndex += 1;
  st.stage = 1;
  st.qpcBase += BAL.progression.realmAdvanceReward.qpcBaseAdd;
  st.qpsBase += BAL.progression.realmAdvanceReward.qpsBaseAdd;

  // User requested: when reaching Qi Refining, set base QPS to exactly 1.
  if (st.realmIndex === REALM_INDEX.qi_refining) {
    st.qpsBase = 1;
  }

  st.currentCycle = cycleForRealm(st.realmIndex);
  return false;
}

function simulate({ hours = 10, clickRate = 3, dt = 0.1, buyEvery = 0.25 }) {
  resetReqCache();
  const maxSeconds = hours * 3600;
  const st = defaultState();

  let t = 0;
  let buyAcc = 0;
  const purchases = {};

  while (t < maxSeconds) {
    st.currentCycle = cycleForRealm(st.realmIndex);

    const gain = productionPerSec(st, clickRate) * dt;
    st.qi += gain;
    st.reinc.lifetimeQi += gain;

    let progressed = true;
    while (progressed) {
      progressed = false;
      const finished = doBreakthrough(st);
      if (finished) {
        return {
          finished: true,
          timeHours: t / 3600,
          realm: realms[st.realmIndex].name,
          stage: st.stage,
          reincarnations: st.reinc.times,
          karma: st.reinc.karma,
          purchases
        };
      }

      const req = stageRequirement(st.realmIndex, st.stage, st.reinc.karma || 0);
      if (st.qi >= req) progressed = true;
    }

    buyAcc += dt;
    if (buyAcc >= buyEvery && st.realmIndex > 0) {
      buyAcc = 0;
      const pick = findBestPurchase(st, clickRate);
      if (pick && applyPurchase(st, pick.id)) {
        purchases[pick.id] = (purchases[pick.id] || 0) + 1;
      }
    }

    t += dt;
  }

  return {
    finished: false,
    timeHours: hours,
    realm: realms[st.realmIndex].name,
    stage: st.stage,
    reincarnations: st.reinc.times,
    karma: st.reinc.karma,
    purchases
  };
}

function runPlaytest() {
  const cases = [
    { label: 'Casual', clickRate: 2, hours: 10 },
    { label: 'Normal', clickRate: 3, hours: 10 },
    { label: 'Dedicated', clickRate: 5, hours: 10 },
    { label: 'Normal-12h', clickRate: 3, hours: 12 },
  ];

  console.log('=== Xianxia Idle Full-Run Playtest ===');
  console.log('Balance:', {
    realmBase: BAL.stageRequirement.realmBase,
    realmBaseScale: BAL.stageRequirement.realmBaseScale,
    stageScale: BAL.stageRequirement.stageScale,
    qpcAdd: BAL.progression.realmAdvanceReward.qpcBaseAdd,
    qpsAdd: BAL.progression.realmAdvanceReward.qpsBaseAdd,
    ranks: Object.fromEntries(Object.entries(BAL.skills).filter(([, s]) => !s.oneTime).map(([id, s]) => [id, s.ranksPerRealm]))
  });

  for (const c of cases) {
    const r = simulate(c);
    const status = r.finished
      ? `FINISHED in ${r.timeHours.toFixed(2)}h | reinc=${r.reincarnations} karma=${r.karma.toFixed(1)}`
      : `NOT finished (${r.realm} ${r.stage}/10) | reinc=${r.reincarnations} karma=${r.karma.toFixed(1)}`;
    console.log(`${c.label.padEnd(10)} | cps=${c.clickRate} | ${status}`);
  }
}

runPlaytest();
