'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createDashboardI18n } = require('../lib/dashboard-i18n');

const root = path.resolve(__dirname, '..');
const dashboardPath = path.join(root, 'examples', 'dashboard-dishwasher-washer-oven.json');
const screenshotPath = path.join(root, 'examples', 'dashboard-screenshot-simulated.json');
const i18nSource = createDashboardI18n.toString();
const bootstrap = `const createDashboardI18n=${i18nSource};\nconst HC=createDashboardI18n(typeof window==='undefined'?{}:window);`;
const labelKeys = [
  'overview', 'connection', 'status', 'door', 'active', 'selected', 'remaining', 'localProfileReadOnly',
  'remoteControl', 'remoteStart', 'localControl', 'currentOptions', 'availablePrograms', 'program',
  'targetTemperature', 'temperature', 'refresh', 'start', 'stop', 'openDetails', 'backToOverview',
  'lastKnownState', 'remoteStartUnavailable', 'language', 'online', 'offline', 'simulated', 'simulatedValues'
];
const computedLabels = `{${labelKeys.map(key => `${key}:HC.t('${key}',this.locale)`).join(',')}}`;

function lifecycle() {
  return `mounted(){this.locale=HC.detectLocale(this,this.msg);this.localeListener=(event)=>{this.locale=HC.normalizeLocale(event.detail?.locale)||this.locale};window.addEventListener(HC.EVENT_NAME,this.localeListener)},\n  beforeUnmount(){if(this.localeListener)window.removeEventListener(HC.EVENT_NAME,this.localeListener)},`;
}

function detailTemplate(kind, icon) {
  return `<template>
  <v-card :id="'hc-'+kind.toLowerCase()" class="hc-card" elevation="2">
    <v-card-title><v-icon class="mr-2">${icon}</v-icon>{{ deviceTitle }}<v-spacer></v-spacer><v-chip v-if="demoMode" color="secondary" size="small" class="mr-2">{{ hcLabels.simulated }}</v-chip><v-chip :color="healthColor" size="small">{{ healthText }}</v-chip></v-card-title>
    <v-card-text>
      <div class="hc-device-info"><b>{{ appliance.name || deviceTitle }}</b><br>{{ appliance.brand || '—' }} · {{ applianceType }}<br><span v-if="appliance.vib">VIB/E-Nummer: {{ appliance.vib }}</span><br><span>{{ hcLabels.connection }}: {{ online ? hcLabels.online : hcLabels.offline }}</span><span v-if="model.stale"> · {{ hcLabels.lastKnownState }}</span></div>
      <v-alert v-for="warning in visibleWarnings" :key="warning.source+warning.code+(warning.key||'')" :type="warningType(warning)" density="compact" variant="tonal" class="mb-2"><b>{{ warningText(warning) }}</b></v-alert>
      <div class="hc-state"><b>{{ hcLabels.status }}:</b> {{ semanticText(model.stateItem) }}</div>
      <div><b>{{ hcLabels.door }}:</b> {{ semanticText(model.doorItem) }}</div>
      <div><b>{{ hcLabels.active }}:</b> {{ displayName(model.active) }}</div>
      <div><b>{{ hcLabels.selected }}:</b> {{ displayName(model.selected) }}</div>
      <div><b>{{ hcLabels.remaining }}:</b> {{ remainingText }}</div>
      <div v-if="statusOnly" class="hc-readonly-panel">
        <div class="hc-readonly-title">{{ demoMode ? hcLabels.simulatedValues : hcLabels.localProfileReadOnly }}</div>
        <div><b>{{ hcLabels.remoteControl }}:</b> {{ booleanText(model.remoteControlItem) }}</div>
        <div><b>{{ hcLabels.remoteStart }}:</b> {{ booleanText(model.remoteStartItem) }}</div>
        <div><b>{{ hcLabels.localControl }}:</b> {{ booleanText(model.localControlItem) }}</div>
        <div v-if="model.options?.length" class="mt-2"><b>{{ hcLabels.currentOptions }}:</b><div v-for="item in model.options" :key="item.key" class="hc-option"><span :title="item.key">{{ displayKey(item.key) }}</span>: {{ semanticText(item) }}<span v-if="item.unit"> {{ item.unit }}</span></div></div>
        <div v-if="programs.length" class="mt-2"><b>{{ hcLabels.availablePrograms }}:</b> {{ programs.map(p=>p.title).join(', ') }}</div>
      </div>
      <template v-else>
        <v-select class="mt-4" v-model="program" :items="programs" item-title="title" item-value="key" :label="hcLabels.program" density="compact"></v-select>
        <v-text-field v-if="kind === 'Oven'" v-model.number="temperature" :label="hcLabels.targetTemperature+' °C'" type="number" min="30" max="250" step="5" density="compact"></v-text-field>
        <v-checkbox v-if="kind === 'Dishwasher'" v-model="boost" :label="displayKey('Dishcare.Dishwasher.Option.VarioSpeedPlus')" density="compact"></v-checkbox>
        <v-select v-if="kind === 'Washer'" v-model="temperatureKey" :items="washerTemperatures" item-title="title" item-value="value" :label="hcLabels.temperature" density="compact"></v-select>
        <div v-if="!canStart && !running" class="hc-control-hint">{{ hcLabels.remoteStartUnavailable }}</div>
      </template>
    </v-card-text>
    <v-card-actions>
      <template v-if="!statusOnly"><v-btn color="primary" :disabled="!program || !canStart" @click="start">{{ hcLabels.start }}</v-btn><v-btn color="error" variant="outlined" :disabled="!running || !online" @click="stop">{{ hcLabels.stop }}</v-btn></template>
      <v-btn variant="text" @click="refresh">{{ hcLabels.refresh }}</v-btn>
    </v-card-actions>
  </v-card>
</template>
<script>
${bootstrap}
export default {
  data(){return{kind:'${kind}',locale:HC.detectLocale(),localeListener:null,program:null,temperature:180,boost:false,temperatureKey:'LaundryCare.Washer.EnumType.Temperature.GC40',washerTemperatures:[{title:'30 °C',value:'LaundryCare.Washer.EnumType.Temperature.GC30'},{title:'40 °C',value:'LaundryCare.Washer.EnumType.Temperature.GC40'},{title:'60 °C',value:'LaundryCare.Washer.EnumType.Temperature.GC60'}]}},
  computed:{
    hcLabels(){return ${computedLabels}},model(){return this.msg?.payload||{}},appliance(){return this.model.appliance||{}},readOnly(){return this.model.readOnly===true},demoMode(){return this.model.simulated===true},statusOnly(){return this.readOnly||this.demoMode},
    deviceTitle(){return HC.deviceType(this.kind,this.locale)},applianceType(){return HC.deviceType(this.appliance.type||this.kind,this.locale)},
    health(){return this.model.health||'ok'},warnings(){return this.model.warnings||[]},visibleWarnings(){return this.warnings.slice(0,4)},
    healthColor(){return({ok:'success',running:'info',info:'info',warning:'warning',action_required:'warning',offline:'grey',error:'error'})[this.health]||'grey'},healthText(){return HC.healthLabel(this.health,this.locale)},
    online(){return this.appliance.connected!==false&&this.health!=='offline'},programs(){return HC.programItems(this.model.programs||[],this.locale)},
    remainingText(){return HC.remaining(this.model,this.locale)},running(){return this.health==='running'||String(this.model.state).endsWith('.Run')},
    canStart(){const s=this.model.status||{};return!this.statusOnly&&this.online&&!this.running&&this.health!=='error'&&this.health!=='action_required'&&s['BSH.Common.Status.RemoteControlActive']!==false&&s['BSH.Common.Status.RemoteControlStartAllowed']!==false&&s['BSH.Common.Status.LocalControlActive']!==true}
  },
  watch:{programs:{immediate:true,handler(value){if(!this.program&&value?.length)this.program=value[0].key}}},
  ${lifecycle()}
  methods:{
    displayName(value){return HC.displayName(value,this.locale)},displayKey(value){return HC.displayKey(value,this.locale)},semanticText(item){return HC.semantic(item,this.locale)},booleanText(item){return HC.booleanText(item,this.locale)},warningText(value){return HC.warningText(value,this.locale)},
    warningType(value){return value.severity==='critical'||value.severity==='error'?'error':value.severity==='warning'?'warning':'info'},
    refresh(){this.send({payload:{action:'refresh'}})},
    start(){const options=[];if(this.kind==='Oven')options.push({key:'Cooking.Oven.Option.SetpointTemperature',value:Number(this.temperature),unit:'°C'});if(this.kind==='Dishwasher'&&this.program==='Dishcare.Dishwasher.Program.Eco50')options.push({key:'Dishcare.Dishwasher.Option.VarioSpeedPlus',value:this.boost});if(this.kind==='Washer'&&this.program==='LaundryCare.Washer.Program.Cotton')options.push({key:'LaundryCare.Washer.Option.Temperature',value:this.temperatureKey});this.send({payload:{action:'start-program',program:this.program,options,confirm:'CONFIRM'}})},
    stop(){this.send({payload:{action:'stop-program',confirm:'CONFIRM'}})}
  }
}
</script>
<style>.hc-card{border-top:4px solid rgb(var(--v-theme-primary));height:100%;scroll-margin-top:72px}.hc-state{margin-bottom:6px}.hc-device-info{padding:8px 0 12px;color:rgba(var(--v-theme-on-surface),.75)}.hc-control-hint{margin-top:8px;color:rgb(var(--v-theme-warning));font-size:.9rem}.hc-readonly-panel{margin-top:14px;padding:12px;border:1px solid rgba(var(--v-theme-on-surface),.18);border-radius:6px;background:rgba(var(--v-theme-on-surface),.035)}.hc-readonly-title{font-weight:600;margin-bottom:8px}.hc-option{padding-left:10px}</style>
`;
}

function overviewTemplate() {
  return `<template>
  <div>
    <div class="hc-toolbar"><div class="hc-heading">{{ hcLabels.overview }}</div><v-select v-model="locale" :items="languageItems" item-title="title" item-value="value" :label="hcLabels.language" density="compact" hide-details class="hc-language" @update:model-value="setLanguage"></v-select></div>
    <div class="hc-overview-grid">
      <v-card v-for="device in cards" :key="device.key" class="hc-overview-card" elevation="2" role="link" tabindex="0" @click="openDetails(device)" @keyup.enter="openDetails(device)">
        <v-card-title><v-icon class="mr-2">{{ device.icon }}</v-icon>{{ device.title }}<v-spacer></v-spacer><v-chip v-if="device.model.simulated" color="secondary" size="small" class="mr-2">{{ hcLabels.simulated }}</v-chip><v-chip :color="healthColor(device.health)" size="small">{{ healthText(device.health) }}</v-chip></v-card-title>
        <v-card-text>
          <div class="hc-meta">{{ device.model.appliance?.name || device.title }} · {{ device.model.appliance?.brand || '—' }} · {{ applianceType(device.model.appliance?.type||device.kind) }}</div>
          <div><b>{{ hcLabels.status }}:</b> {{ semantic(device.model.stateItem) }}</div>
          <div><b>{{ hcLabels.program }}:</b> {{ displayName(device.model.active) }}</div>
          <div><b>{{ hcLabels.remaining }}:</b> {{ remaining(device.model) }}</div>
          <v-alert v-if="device.warning" :type="warningType(device.warning)" density="compact" variant="tonal" class="mt-2"><b>{{ warningText(device.warning) }}</b></v-alert>
          <div class="hc-open">{{ hcLabels.openDetails }} →</div>
        </v-card-text>
      </v-card>
    </div>
  </div>
</template>
<script>
${bootstrap}
export default{
  data(){return{locale:HC.detectLocale(),localeListener:null}},
  computed:{
    hcLabels(){return ${computedLabels}},models(){return this.msg?.payload||{}},languageItems(){return[{title:'Deutsch',value:'de'},{title:'English',value:'en'}]},
    cards(){return[{key:'dishwasher',kind:'Dishwasher',icon:'mdi-dishwasher',model:this.models.dishwasher||{}},{key:'washer',kind:'Washer',icon:'mdi-washing-machine',model:this.models.washer||{}},{key:'oven',kind:'Oven',icon:'mdi-stove',model:this.models.oven||{}}].map(device=>({...device,title:HC.deviceType(device.kind,this.locale),health:device.model.health||'ok',warning:(device.model.warnings||[])[0]}))}
  },
  ${lifecycle()}
  methods:{
    setLanguage(value){this.locale=HC.setLocale(value)},applianceType(value){return HC.deviceType(value,this.locale)},displayName(value){return HC.displayName(value,this.locale)},semantic(item){return HC.semantic(item,this.locale)},remaining(model){return HC.remaining(model,this.locale)},healthText(value){return HC.healthLabel(value,this.locale)},warningText(value){return HC.warningText(value,this.locale)},
    healthColor(value){return({ok:'success',running:'info',info:'info',warning:'warning',action_required:'warning',offline:'grey',error:'error'})[value]||'grey'},warningType(value){return value?.severity==='critical'||value?.severity==='error'?'error':value?.severity==='warning'?'warning':'info'},
    openDetails(device){window.location.assign(window.location.pathname.replace(/\\/[^/]*$/,'/home-connect')+'#hc-'+device.key)}
  }
}
</script>
<style>.hc-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}.hc-heading{font-size:1.35rem;font-weight:600}.hc-language{max-width:180px}.hc-overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.hc-overview-card{cursor:pointer;border-top:4px solid rgb(var(--v-theme-primary));transition:transform .12s}.hc-overview-card:hover,.hc-overview-card:focus{transform:translateY(-2px);outline:2px solid rgb(var(--v-theme-primary))}.hc-meta{color:rgba(var(--v-theme-on-surface),.7);margin-bottom:8px}.hc-open{margin-top:12px;color:rgb(var(--v-theme-primary));font-weight:600}</style>
`;
}

function navTemplate() {
  return `<template><div class="hc-nav"><v-btn variant="text" prepend-icon="mdi-arrow-left" @click="back">{{ hcLabels.backToOverview }}</v-btn><v-select v-model="locale" :items="languageItems" item-title="title" item-value="value" :label="hcLabels.language" density="compact" hide-details class="hc-language" @update:model-value="setLanguage"></v-select></div></template><script>\n${bootstrap}\nexport default{data(){return{locale:HC.detectLocale(),localeListener:null}},computed:{hcLabels(){return ${computedLabels}},languageItems(){return[{title:'Deutsch',value:'de'},{title:'English',value:'en'}]}},${lifecycle()}methods:{setLanguage(value){this.locale=HC.setLocale(value)},back(){window.location.assign(window.location.pathname.replace(/\\/[^/]*$/,'/overview'))}}}</script><style>.hc-nav{display:flex;align-items:center;justify-content:space-between;gap:16px}.hc-language{max-width:180px}</style>`;
}

const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf8'));
const mainReducer = dashboard.find(node => node.id === 'hc-dashboard-state');
if (!mainReducer.func.includes('simulated:value.simulated===true')) {
  mainReducer.func = mainReducer.func
    .replace("warnings:[],readOnly:false,stale:false}", "warnings:[],readOnly:false,simulated:false,stale:false}")
    .replace("model.appliance={...model.appliance,...snapshot.appliance}; model.readOnly=snapshot.readOnly===true;", "model.appliance={...model.appliance,...snapshot.appliance}; model.readOnly=snapshot.readOnly===true; model.simulated=snapshot.simulated===true;")
    .replace("return {appliance:value.appliance,programs:", "return {appliance:value.appliance,simulated:value.simulated===true,programs:");
}
const formats = {
  'hc-ui-dw': detailTemplate('Dishwasher', 'mdi-dishwasher'),
  'hc-ui-wm': detailTemplate('Washer', 'mdi-washing-machine'),
  'hc-ui-ov': detailTemplate('Oven', 'mdi-stove'),
  'hc-ui-overview': overviewTemplate(),
  'hc-ui-nav': navTemplate()
};
for (const node of dashboard) {
  if (formats[node.id]) node.format = formats[node.id];
  if (['hc-group-dw', 'hc-group-wm', 'hc-group-ov', 'hc-ui-overview-group'].includes(node.id)) node.showTitle = false;
  if (node.id === 'hc-ui-overview-page') node.name = 'Home Connect';
  if (node.id === 'hc-ui-page') node.name = 'Home Connect · Details';
  if (node.id === 'hc-comment') node.name = 'Dashboard 2.0 · DE/EN lokalisiert · Cloud + Local read-only · Built-in simulator';
}
fs.writeFileSync(dashboardPath, `${JSON.stringify(dashboard, null, 2)}\n`);

const keepIds = new Set(['hc-dashboard-flow', 'hc-comment', 'hc-ui-base', 'hc-ui-theme', 'hc-ui-page', 'hc-group-dw', 'hc-group-wm', 'hc-group-ov', 'hc-dashboard-state', 'hc-ui-dw', 'hc-ui-wm', 'hc-ui-ov', 'hc-ui-overview-page', 'hc-ui-overview-group', 'hc-ui-overview', 'hc-ui-nav-group', 'hc-ui-nav']);
const idMap = new Map([...keepIds].map(id => [id, `demo-hc-r9-fix1-${id.replace(/^hc-/, '')}`]));
const screenshot = dashboard.filter(node => keepIds.has(node.id)).map(node => {
  const copy = JSON.parse(JSON.stringify(node));
  copy.id = idMap.get(node.id);
  if (copy.z && idMap.has(copy.z)) copy.z = idMap.get(copy.z);
  for (const field of ['group', 'page', 'ui', 'theme']) if (copy[field] && idMap.has(copy[field])) copy[field] = idMap.get(copy[field]);
  copy.wires = (copy.wires || []).map(output => output.filter(target => idMap.has(target)).map(target => idMap.get(target)));
  if (copy.type === 'ui-template') {
    copy.format = copy.format
      .replace("const HC=createDashboardI18n(typeof window==='undefined'?{}:window);", "const HC=createDashboardI18n(typeof window==='undefined'?{}:window,{storageKey:'demo-home-connect-dashboard-language-r9-fix1',eventName:'demo-home-connect-language-changed-r9-fix1'});")
      .replace("'/home-connect'", "'/demo-details'")
      .replace("'/overview'", "'/demo-overview'")
      .replace("deviceTitle(){return HC.deviceType(this.kind,this.locale)}", "deviceTitle(){return 'Demo '+HC.deviceType(this.kind,this.locale)}")
      .replace("title:HC.deviceType(device.kind,this.locale)", "title:'Demo '+HC.deviceType(device.kind,this.locale)")
      .replace("{{ appliance.name || deviceTitle }}", "{{ demoMode ? deviceTitle : (appliance.name || deviceTitle) }}")
      .replace("{{ device.model.appliance?.name || device.title }}", "{{ device.model.simulated ? device.title : (device.model.appliance?.name || device.title) }}");
  }
  return copy;
});
const demoNames = {
  'hc-comment': 'Demo vollständig simuliert · keine Credentials, Geräte-IDs, IPs oder lokalen Profile',
  'hc-ui-base': 'Demo Home Connect',
  'hc-ui-theme': 'Demo Home Connect',
  'hc-ui-page': 'Demo Gerätedetails',
  'hc-group-dw': 'Demo Geschirrspüler',
  'hc-group-wm': 'Demo Waschmaschine',
  'hc-group-ov': 'Demo Backofen',
  'hc-dashboard-state': 'Demo Zustand zusammenführen',
  'hc-ui-dw': 'Demo Geschirrspüler',
  'hc-ui-wm': 'Demo Waschmaschine',
  'hc-ui-ov': 'Demo Backofen',
  'hc-ui-overview-page': 'Demo Übersicht',
  'hc-ui-overview-group': 'Demo Übersicht',
  'hc-ui-overview': 'Demo Gerätekarten',
  'hc-ui-nav-group': 'Demo Navigation',
  'hc-ui-nav': 'Demo Zur Übersicht'
};
for (const [sourceId, name] of Object.entries(demoNames)) screenshot.find(node => node.id === idMap.get(sourceId)).name = name;
const tab = screenshot.find(node => node.id === idMap.get('hc-dashboard-flow'));
tab.label = 'Demo Home Connect';
const base = screenshot.find(node => node.id === idMap.get('hc-ui-base'));
base.path = '/demo-home-connect-r9-fix1';
screenshot.find(node => node.id === idMap.get('hc-ui-overview-page')).path = '/demo-overview';
screenshot.find(node => node.id === idMap.get('hc-ui-page')).path = '/demo-details';
const reducer = screenshot.find(node => node.id === idMap.get('hc-dashboard-state'));
reducer.wires = [[idMap.get('hc-ui-dw')], [idMap.get('hc-ui-wm')], [idMap.get('hc-ui-ov')], [idMap.get('hc-ui-overview')]];
for (const id of ['hc-ui-dw', 'hc-ui-wm', 'hc-ui-ov']) {
  const node = screenshot.find(item => item.id === idMap.get(id));
  node.wires = [['demo-hc-r9-fix1-data']];
}
const demoFunction = {
  id: 'demo-hc-r9-fix1-data', type: 'function', z: idMap.get('hc-dashboard-flow'), name: 'Demo Beispielgeräte erzeugen',
  func: `const status=(key,value,extra={})=>({key,value,valueResolved:true,category:'status',...extra});\nconst option=(key,value,extra={})=>({key,value,valueResolved:true,category:'option',...extra});\nconst common=(haId,name,type,health,warnings=[])=>({haId,health,warnings,payload:{simulated:true,readOnly:false,local:false,appliance:{haId,name,brand:'SIEMENS',type,connected:true,vib:'DEMO-'+type.toUpperCase()+'-2026'},status:{items:[]},settings:{items:[]},values:{items:[]},programs:{available:[],active:null,selected:null,options:[]},connection:{local:false,readOnly:false,state:'online'}}});\nconst dishwasher=common('demo-simulated-dishwasher','Demo Geschirrspüler','Dishwasher','running');\ndishwasher.payload.status.items=[status('BSH.Common.Status.OperationState','BSH.Common.EnumType.OperationState.Run'),status('BSH.Common.Status.DoorState','BSH.Common.EnumType.DoorState.Closed'),status('BSH.Common.Status.RemoteControlActive',true),status('BSH.Common.Status.RemoteControlStartAllowed',true),status('BSH.Common.Status.LocalControlActive',false)];\ndishwasher.payload.values.items=[option('BSH.Common.Option.RemainingProgramTime',3720,{unit:'seconds'}),option('BSH.Common.Option.ProgramProgress',43,{unit:'%'})];\ndishwasher.payload.programs={available:[{key:'Dishcare.Dishwasher.Program.Intensiv70'},{key:'Dishcare.Dishwasher.Program.Auto2'},{key:'Dishcare.Dishwasher.Program.Eco50'},{key:'Dishcare.Dishwasher.Program.Glas40'},{key:'Dishcare.Dishwasher.Program.Quick45'}],active:{key:'Dishcare.Dishwasher.Program.Eco50'},selected:{key:'Dishcare.Dishwasher.Program.Eco50'},options:[option('BSH.Common.Option.ProgramProgress',43,{unit:'%'}),option('BSH.Common.Option.EnergyForecast',62,{unit:'%'}),option('BSH.Common.Option.WaterForecast',48,{unit:'%'}),option('Dishcare.Dishwasher.Option.HygienePlus',true),option('Dishcare.Dishwasher.Option.IntensivZone',false),option('Dishcare.Dishwasher.Option.VarioSpeedPlus',true),option('Dishcare.Dishwasher.Option.BrillianceDry',true)]};\nconst washer=common('demo-simulated-washer','Demo Waschmaschine','Washer','warning',[{source:'event',code:'HC_EVENT_DETERGENT_NEARLY_EMPTY',severity:'warning',text:{de:'Dosierbehälter fast leer.',en:'Detergent dispenser nearly empty.'}}]);\nwasher.payload.status.items=[status('BSH.Common.Status.OperationState','BSH.Common.EnumType.OperationState.Ready'),status('BSH.Common.Status.DoorState','BSH.Common.EnumType.DoorState.Closed'),status('BSH.Common.Status.RemoteControlActive',true),status('BSH.Common.Status.RemoteControlStartAllowed',false),status('BSH.Common.Status.LocalControlActive',false)];\nwasher.payload.programs={available:[{key:'LaundryCare.Washer.Program.Cotton'},{key:'LaundryCare.Washer.Program.EasyCare'},{key:'LaundryCare.Washer.Program.Mix'},{key:'LaundryCare.Washer.Program.DelicatesSilk'},{key:'LaundryCare.Washer.Program.Wool'},{key:'LaundryCare.Washer.Program.Super15'}],active:null,selected:{key:'LaundryCare.Washer.Program.Cotton'},options:[option('LaundryCare.Washer.Option.Temperature','LaundryCare.Washer.EnumType.Temperature.GC40'),option('LaundryCare.Washer.Option.SpinSpeed','LaundryCare.Washer.EnumType.SpinSpeed.RPM1400')]};\nconst oven=common('demo-simulated-oven','Demo Backofen','Oven','running');\noven.payload.status.items=[status('BSH.Common.Status.OperationState','BSH.Common.EnumType.OperationState.Run'),status('BSH.Common.Status.DoorState','BSH.Common.EnumType.DoorState.Closed'),status('BSH.Common.Status.RemoteControlActive',true),status('BSH.Common.Status.RemoteControlStartAllowed',true),status('BSH.Common.Status.LocalControlActive',false)];\noven.payload.values.items=[option('BSH.Common.Option.RemainingProgramTime',1680,{unit:'seconds'})];\noven.payload.programs={available:[{key:'Cooking.Oven.Program.HeatingMode.HotAir'},{key:'Cooking.Oven.Program.HeatingMode.TopBottomHeating'},{key:'Cooking.Oven.Program.HeatingMode.PizzaSetting'},{key:'Cooking.Oven.Program.HeatingMode.HotAirGrilling'},{key:'Cooking.Oven.Program.HeatingMode.SlowCook'}],active:{key:'Cooking.Oven.Program.HeatingMode.HotAir'},selected:{key:'Cooking.Oven.Program.HeatingMode.HotAir'},options:[option('Cooking.Oven.Option.SetpointTemperature',180,{unit:'°C'}),option('Cooking.Oven.Option.FastPreHeat',false),option('BSH.Common.Option.ProgramProgress',68,{unit:'%'})]};\nreturn [[dishwasher,washer,oven]];`,
  outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 360, y: 120, wires: [[idMap.get('hc-dashboard-state')]]
};
const inject = {
  id: 'demo-hc-r9-fix1-inject', type: 'inject', z: idMap.get('hc-dashboard-flow'), name: 'Demo Daten laden', props: [{ p: 'payload' }],
  repeat: '', crontab: '', once: true, onceDelay: 0.5, topic: '', payload: '', payloadType: 'date', x: 130, y: 120, wires: [['demo-hc-r9-fix1-data']]
};
screenshot.push(inject, demoFunction);
fs.writeFileSync(screenshotPath, `${JSON.stringify(screenshot, null, 2)}\n`);
console.log(`updated ${path.relative(root, dashboardPath)} and ${path.relative(root, screenshotPath)}`);
