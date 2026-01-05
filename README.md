# 🗡️ Xianxia Idle DEMO

**Xianxia Idle** is a browser-based **idle clicker game** inspired by Chinese cultivation (修仙 *xiūxiān*) stories.  
Players cultivate their Qi, unlock powerful skills, and ascend through spiritual realms by clicking and meditating.

## 🌿 Features
- Idle & Clicker gameplay — gain Qi actively or passively.  
- Skill system — purchase abilities to boost Qi gain and offline progress.  
- Realm progression — advance through **Qi Refining**, **Foundation Establishment**, **Golden Core**, **Nascent Soul**, and **Spirit Transformation** (each with 10 stages).  
- Autosave every 15s + manual save, export & import system.  
- Offline Qi accumulation when the game is closed.  

## 🕹️ How to Play
1. Click the cultivator image to generate Qi.  
2. Use your Qi to buy skills from the right panel.  
3. Break through each realm once you meet the Qi requirement.  
4. Progress and watch your cultivation rise endlessly!  

## 💾 Tech Stack
- **HTML**, **CSS**, **JavaScript** (no frameworks)  
- **LocalStorage** for save data  
- Fully client-side — no backend required  

## 🚀 Demo
Play it online: (https://xianxia-idle-demo.netlify.app/)

---

Made with ❤️ by **Santiago**  
*“Cultivate your patience as you cultivate your Qi.”*









Changes in this MOD:

1/
Added 4 buttons through Html file. Inside the html file, just before the ending body tag, added the code below:
<div style="position:fixed; bottom:10px; right:10px; background:#0b0f14; border:1px solid #7ee787; padding:15px; z-index:99999; border-radius:8px; box-shadow:0 0 20px rgba(0,0,0,0.8); color:#e6edf3; font-family:sans-serif;">
  <h4 style="margin:0 0 10px 0; color:#7ee787; text-transform:uppercase;">Dev Hacks</h4>
  
  <div style="display:flex; flex-direction:column; gap:5px;">
    <button onclick="S.qi += 1e50; S.reinc.lifetimeQi += 1e50; renderAll();" style="cursor:pointer; padding:5px; background:#121923; border:1px solid #7ee787; color:#fff;">
      ⚡ Add 1e50 Qi
    </button>
    
    <button onclick="S.reinc.karma += 50000; renderAll();" style="cursor:pointer; padding:5px; background:#121923; border:1px solid #a18aff; color:#fff;">
      ☯ Add 50k Karma
    </button>

    <button onclick="doBreakthrough(); S.qi = stageRequirement(S.realmIndex, S.stage); doBreakthrough();" style="cursor:pointer; padding:5px; background:#121923; border:1px solid #ff6b6b; color:#fff;">
      🚀 Force Breakthrough
    </button>
    
    <button onclick="Object.keys(BAL.skills).forEach(k => S.skills[k] = (S.skills[k]||0)+100); renderAll();" style="cursor:pointer; padding:5px; background:#121923; border:1px solid #ffd700; color:#fff;">
      📚 +100 All Skills
    </button>
  </div>
</div>


2/
Renamed the realms. Inside main.js file, Just after the 'const realms' (line 505) modified to code below.
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




Everything remains same.






