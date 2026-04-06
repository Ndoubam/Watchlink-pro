import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, StatusBar, Animated, Alert, Platform,
  PermissionsAndroid, ActivityIndicator, Switch,
} from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

/* ══ NUS UUIDs T800 Ultra ══ */
const NUS_SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9d';
const NUS_TX  = '6e400002-b5a3-f393-e0a9-e50e24dcca9d';
const NUS_RX  = '6e400003-b5a3-f393-e0a9-e50e24dcca9d';

/* ══ PROTOCOLE ══ */
const CMD = {
  SYNC_TIME:0x01, REQUEST_HR:0x04, REQUEST_STEPS:0x05,
  SET_ALARM:0x09, REQUEST_SPO2:0x0C, REQUEST_BAT:0x0B,
  NOTIFICATION:0x11, SET_WATCHFACE:0x1D, HR_REALTIME:0x69,
  SEDENTARY:0x1F,
};

function buildPkt(cmd, data = []) {
  const len = data.length;
  const pkt = [0xCD, cmd, (len >> 8) & 0xFF, len & 0xFF, ...data];
  let xor = 0;
  for (let i = 1; i < pkt.length; i++) xor ^= pkt[i];
  pkt.push(xor);
  return Buffer.from(pkt).toString('base64');
}

function buildTimePkt() {
  const n = new Date();
  return buildPkt(CMD.SYNC_TIME, [
    n.getFullYear() - 2000, n.getMonth() + 1, n.getDate(),
    n.getHours(), n.getMinutes(), n.getSeconds(), n.getDay(),
  ]);
}

function buildNotifPkt(title, body) {
  const enc = s => Array.from(new TextEncoder().encode(s));
  const t = enc(title.substring(0, 20));
  const b = enc(body.substring(0, 60));
  return buildPkt(CMD.NOTIFICATION, [0x03, ...t, 0x00, ...b, 0x00]);
}

function buildAlarmPkt(h, m, on) {
  return buildPkt(CMD.SET_ALARM, [on ? 0x01 : 0x00, h, m, 0x7F]);
}

function hexFromB64(b64) {
  return Array.from(Buffer.from(b64, 'base64'))
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function pad(n) { return String(n).padStart(2, '0'); }

/* ══ BLEMANAGER SINGLETON ══ */
const manager = new BleManager();

/* ══ COULEURS ══ */
const C = {
  bg: '#000814', bg2: '#000d1a', bg3: '#001226',
  cyan: '#00e5ff', orange: '#ff6b35', green: '#00ff88',
  red: '#ff2d55', purple: '#cc44ff', dim: '#5a7a8a',
  text: '#c8e6f5', border: 'rgba(0,229,255,0.2)',
  card: 'rgba(0,18,38,0.9)',
};

export default function App() {
  /* ── State ── */
  const [screen, setScreen] = useState('home'); // home | sensors | settings
  const [connState, setConnState] = useState('disconnected'); // disconnected | scanning | connecting | connected
  const [device, setDevice] = useState(null);
  const [txChar, setTxChar] = useState(null);
  const [logs, setLogs] = useState(['── NUS Log ── En attente...']);
  const [sensors, setSensors] = useState({ hr: '--', spo2: '--', steps: '----', bat: '--' });
  const [modal, setModal] = useState(null); // null | 'connect' | 'notif' | 'alarm' | 'chrono'
  const [theme, setTheme] = useState('arctic');
  const [notifTitle, setNotifTitle] = useState('');
  const [notifBody, setNotifBody] = useState('');
  const [rawHex, setRawHex] = useState('');
  const [lastRx, setLastRx] = useState('—');
  const [scanList, setScanList] = useState([]);
  const [hr24, setHr24] = useState(false);
  const [notifOn, setNotifOn] = useState(true);
  const [sedOn, setSedOn] = useState(false);
  const [chrono, setChrono] = useState(0);
  const [chronoRunning, setChronoRunning] = useState(false);

  const txRef = useRef(null);
  const deviceRef = useRef(null);
  const scanSub = useRef(null);
  const chronoRef = useRef(null);
  const chronoStart = useRef(0);

  /* ── Clock ── */
  const [clock, setClock] = useState('');
  const [dateStr, setDateStr] = useState('');
  useEffect(() => {
    const DAYS = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
    const MONTHS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
    const tick = () => {
      const n = new Date();
      setClock(pad(n.getHours()) + ':' + pad(n.getMinutes()));
      setDateStr(DAYS[n.getDay()] + ' ' + n.getDate() + ' ' + MONTHS[n.getMonth()]);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  /* ── Permissions Android ── */
  const requestPermissions = async () => {
    if (Platform.OS !== 'android') return true;
    const perms = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ];
    const result = await PermissionsAndroid.requestMultiple(perms);
    return Object.values(result).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  };

  /* ── Log ── */
  const addLog = useCallback((msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString('fr', { hour12: false });
    setLogs(prev => [...prev.slice(-50), `[${ts}] ${msg}`]);
  }, []);

  /* ── NUS Send ── */
  const nusSend = useCallback(async (b64) => {
    if (!txRef.current || !deviceRef.current) {
      addLog('⚠️ Non connecté', 'err');
      return false;
    }
    try {
      await txRef.current.writeWithoutResponse(b64);
      addLog('TX → ' + hexFromB64(b64), 'tx');
      return true;
    } catch (e) {
      addLog('TX ERR: ' + e.message, 'err');
      return false;
    }
  }, [addLog]);

  /* ── NUS Receive ── */
  const parsePacket = useCallback((b64) => {
    const bytes = Array.from(Buffer.from(b64, 'base64'));
    const hex = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    setLastRx(hex);
    addLog('RX ← ' + hex, 'rx');
    if (bytes.length < 3 || bytes[0] !== 0xCD) return;
    const cmd = bytes[1];
    if ((cmd === CMD.REQUEST_HR || cmd === CMD.HR_REALTIME) && bytes.length >= 5) {
      const v = bytes[4];
      if (v > 30 && v < 220) setSensors(s => ({ ...s, hr: String(v) }));
    } else if (cmd === CMD.REQUEST_SPO2 && bytes.length >= 5) {
      const v = bytes[4];
      if (v > 80 && v <= 100) setSensors(s => ({ ...s, spo2: String(v) }));
    } else if (cmd === CMD.REQUEST_STEPS && bytes.length >= 6) {
      const v = (bytes[4] << 8) | bytes[5];
      setSensors(s => ({ ...s, steps: v.toLocaleString() }));
    } else if (cmd === CMD.REQUEST_BAT && bytes.length >= 5) {
      setSensors(s => ({ ...s, bat: String(bytes[4]) }));
    }
  }, [addLog]);

  /* ── Scan & Connect ── */
  const startScan = async () => {
    const ok = await requestPermissions();
    if (!ok) { Alert.alert('Permissions requises', 'Active les permissions Bluetooth et Localisation.'); return; }
    setScanList([]);
    setConnState('scanning');
    addLog('Scan BLE démarré...', 'info');
    manager.startDeviceScan(null, { allowDuplicates: false }, (err, dev) => {
      if (err) { addLog('Scan err: ' + err.message, 'err'); setConnState('disconnected'); return; }
      if (dev && dev.name) {
        setScanList(prev => {
          if (prev.find(d => d.id === dev.id)) return prev;
          return [...prev, { id: dev.id, name: dev.name, rssi: dev.rssi }];
        });
      }
    });
    setTimeout(() => { manager.stopDeviceScan(); if (connState === 'scanning') setConnState('disconnected'); }, 10000);
  };

  const connectTo = async (dev) => {
    manager.stopDeviceScan();
    setConnState('connecting');
    addLog('Connexion à ' + dev.name + '...', 'info');
    try {
      const connected = await manager.connectToDevice(dev.id, { autoConnect: false });
      await connected.discoverAllServicesAndCharacteristics();
      addLog('GATT connecté ✅', 'ok');

      const services = await connected.services();
      addLog(services.length + ' services trouvés', 'info');

      // Récupérer NUS TX
      const chars = await connected.characteristicsForService(NUS_SVC);
      const tx = chars.find(c => c.uuid.toLowerCase() === NUS_TX);
      const rx = chars.find(c => c.uuid.toLowerCase() === NUS_RX);

      if (!tx || !rx) throw new Error('Service NUS TX/RX introuvable');

      txRef.current = tx;
      deviceRef.current = connected;
      setTxChar(tx);
      setDevice(connected);

      // Activer notifications RX
      connected.monitorCharacteristicForService(NUS_SVC, NUS_RX, (err, char) => {
        if (err) { addLog('RX err: ' + err.message, 'err'); return; }
        if (char?.value) parsePacket(char.value);
      });

      setConnState('connected');
      addLog('=== CONNECTÉ ✅ ===', 'ok');
      setModal(null);

      // Sync heure automatique
      setTimeout(() => nusSend(buildTimePkt()), 1500);

      // Déconnexion auto-detect
      connected.onDisconnected((err) => {
        addLog('Déconnecté: ' + (err?.message || ''), 'err');
        setConnState('disconnected');
        txRef.current = null;
        deviceRef.current = null;
        setDevice(null);
        setTxChar(null);
      });

    } catch (e) {
      addLog('Erreur: ' + e.message, 'err');
      setConnState('disconnected');
      Alert.alert('Connexion échouée', e.message + '\n\nVérifie que la montre n\'est pas connectée à une autre app.');
    }
  };

  const disconnect = async () => {
    if (deviceRef.current) {
      try { await deviceRef.current.cancelConnection(); } catch (e) {}
    }
    txRef.current = null;
    deviceRef.current = null;
    setDevice(null);
    setTxChar(null);
    setConnState('disconnected');
    addLog('Déconnecté manuellement', 'info');
  };

  /* ── Actions ── */
  const syncTime = () => nusSend(buildTimePkt());
  const requestHR = () => nusSend(buildPkt(CMD.HR_REALTIME, [0x01]));
  const requestSpo2 = () => nusSend(buildPkt(CMD.REQUEST_SPO2, [0x01]));
  const requestSteps = () => nusSend(buildPkt(CMD.REQUEST_STEPS, []));
  const requestBat = () => nusSend(buildPkt(CMD.REQUEST_BAT, []));

  const applyTheme = (name, index) => {
    setTheme(name);
    nusSend(buildPkt(CMD.SET_WATCHFACE, [index & 0xFF]));
  };

  const sendNotif = async () => {
    if (!notifBody) { Alert.alert('Message vide', 'Entre un message à envoyer.'); return; }
    await nusSend(buildNotifPkt(notifTitle || 'Message', notifBody));
    setNotifBody('');
    setModal(null);
  };

  const sendRaw = () => {
    const hex = rawHex.replace(/\s+/g, '');
    if (!hex || hex.length % 2 !== 0) { Alert.alert('HEX invalide'); return; }
    const b64 = Buffer.from(hex.match(/.{2}/g).map(h => parseInt(h, 16))).toString('base64');
    nusSend(b64);
  };

  /* ── Chrono ── */
  useEffect(() => {
    if (chronoRunning) {
      chronoStart.current = Date.now() - chrono;
      chronoRef.current = setInterval(() => setChrono(Date.now() - chronoStart.current), 33);
    } else {
      clearInterval(chronoRef.current);
    }
    return () => clearInterval(chronoRef.current);
  }, [chronoRunning]);

  const chronoStr = () => {
    const m = Math.floor(chrono / 60000);
    const s = Math.floor((chrono % 60000) / 1000);
    const ms = chrono % 1000;
    return `${pad(m)}:${pad(s)}.${String(ms).padStart(3, '0')}`;
  };

  /* ── Thème watchface CSS → couleur ── */
  const themeColors = { ocean: '#0088ff', fire: '#ff4400', matrix: '#00ff44', nebula: '#aa44ff', arctic: '#00e5ff' };
  const themeBg = {
    ocean: ['#001a3a', '#003366'], fire: ['#1a0800', '#3a1200'],
    matrix: ['#001a00', '#003300'], nebula: ['#0d0020', '#200040'],
    arctic: ['#001520', '#002a3a'],
  };

  /* ═══════════════════════════════════════
     RENDER
  ═══════════════════════════════════════ */
  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* HEADER */}
      <View style={s.header}>
        <Text style={s.logo}>WATCH<Text style={{ color: C.orange }}>LINK</Text> PRO</Text>
        <TouchableOpacity style={[s.badge, connState === 'connected' ? s.badgeConn : connState === 'connecting' || connState === 'scanning' ? s.badgeConn2 : s.badgeDisc]}
          onPress={() => connState === 'connected' ? disconnect() : setModal('connect')}>
          <View style={[s.dot, { backgroundColor: connState === 'connected' ? C.green : connState === 'scanning' || connState === 'connecting' ? C.orange : C.dim }]} />
          <Text style={[s.badgeText, { color: connState === 'connected' ? C.green : connState === 'scanning' || connState === 'connecting' ? C.orange : C.dim }]}>
            {connState === 'connected' ? 'CONNECTÉ' : connState === 'connecting' ? 'CONNEXION...' : connState === 'scanning' ? 'SCAN...' : 'DÉCONNECTÉ'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* PAGES */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 90 }}>
        {screen === 'home' && <HomeScreen />}
        {screen === 'sensors' && <SensorsScreen />}
        {screen === 'settings' && <SettingsScreen />}
      </ScrollView>

      {/* BOTTOM NAV */}
      <View style={s.nav}>
        {[['🏠','Accueil','home'],['📊','Capteurs','sensors'],['⚙️','Réglages','settings']].map(([icon,label,id]) => (
          <TouchableOpacity key={id} style={s.navItem} onPress={() => setScreen(id)}>
            <Text style={[s.navIcon, { opacity: screen === id ? 1 : 0.35 }]}>{icon}</Text>
            <Text style={[s.navLabel, { color: screen === id ? C.cyan : C.dim }]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* MODALS */}
      {modal === 'connect' && <ConnectModal />}
      {modal === 'notif' && <NotifModal />}
      {modal === 'alarm' && <AlarmModal />}
      {modal === 'chrono' && <ChronoModal />}
    </View>
  );

  /* ═══════════════ HOME ═══════════════ */
  function HomeScreen() {
    const themes = [
      { name:'ocean', label:'OCEAN', idx:1 },
      { name:'fire',  label:'FIRE',  idx:2 },
      { name:'matrix',label:'MATRIX',idx:3 },
      { name:'nebula',label:'NEBULA',idx:4 },
      { name:'arctic',label:'ARCTIC',idx:0 },
    ];
    const apps = [
      { icon:'❤️', name:'CARDIO', desc:'Mesure FC BLE', color:C.red, action:() => { requestHR(); Alert.alert('Cardio','Mesure FC lancée → vois les données dans Capteurs'); }},
      { icon:'⏱️', name:'CHRONO', desc:'Chronomètre',  color:C.cyan, action:() => setModal('chrono') },
      { icon:'🦶', name:'PODOMÈTRE', desc:'Pas + km',  color:C.orange, action:requestSteps },
      { icon:'📲', name:'NOTIFICATION', desc:'Message', color:C.purple, action:() => setModal('notif') },
      { icon:'⏰', name:'ALARMES', desc:'Gérer alarmes', color:C.green, action:() => setModal('alarm') },
      { icon:'🩺', name:'SPO2', desc:'Saturation O₂', color:'#ffcc00', action:requestSpo2 },
    ];
    return (
      <View>
        {/* Watch card */}
        <View style={s.watchCard}>
          <View style={[s.watchFace, { backgroundColor: themeBg[theme][0], borderColor: themeColors[theme] }]}>
            <Text style={[s.wfTime, { color: themeColors[theme] }]}>{clock}</Text>
            <Text style={s.wfDate}>{dateStr}</Text>
            <Text style={{ fontSize: 10, marginTop: 4 }}>❤️ 🦶 🔋</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.watchModel}>T800 ULTRA</Text>
            <Text style={s.watchAddr}>50:22:33:08:0D:6D</Text>
            <View style={s.statsGrid}>
              {[['❤️','FC',sensors.hr,C.red],['🩺','SpO2',sensors.spo2+'%',C.cyan],
                ['🦶','Pas',sensors.steps,C.orange],['🔋','Bat',sensors.bat+'%',C.green]].map(([ic,lb,val,col]) => (
                <View key={lb} style={s.statItem}>
                  <Text style={s.statLabel}>{ic} {lb}</Text>
                  <Text style={[s.statVal, { color: col }]}>{val}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        {/* NUS Log */}
        <View style={s.nusLog}>
          {logs.slice(-4).map((l, i) => (
            <Text key={i} style={[s.nusLine, l.includes('RX')? {color:C.green} : l.includes('TX')? {color:C.cyan} : l.includes('ERR')? {color:C.red} : {color:C.dim}]}>{l}</Text>
          ))}
        </View>

        {/* Themes */}
        <SectionTitle title="🎨 Thèmes Watchface" />
        <View style={s.themesGrid}>
          {themes.map(t => (
            <TouchableOpacity key={t.name} style={[s.themeCard, { backgroundColor: themeBg[t.name][0] }, theme === t.name && { borderColor: C.cyan, borderWidth: 2 }]}
              onPress={() => applyTheme(t.name, t.idx)}>
              <View style={[s.themeDot, { backgroundColor: themeColors[t.name], shadowColor: themeColors[t.name] }]} />
              <Text style={s.themeLabel}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Apps */}
        <SectionTitle title="⚡ Mini Applications" />
        <View style={s.appsGrid}>
          {apps.map(a => (
            <TouchableOpacity key={a.name} style={s.appCard} onPress={a.action} activeOpacity={0.8}>
              <View style={[s.appAccent, { backgroundColor: a.color }]} />
              <Text style={s.appIcon}>{a.icon}</Text>
              <Text style={s.appName}>{a.name}</Text>
              <Text style={s.appDesc}>{a.desc}</Text>
              <Text style={[s.appStatus, { color: a.color }]}>▶ LANCER</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  }

  /* ═══════════════ SENSORS ═══════════════ */
  function SensorsScreen() {
    return (
      <View style={{ padding: 16 }}>
        <SectionTitle title="📊 Données en Direct" />

        <View style={s.sensorCard}>
          <Text style={[s.sensorTitle, { color: C.red }]}>❤️ FRÉQUENCE CARDIAQUE</Text>
          <Text style={[s.sensorBig, { color: C.red }]}>{sensors.hr} <Text style={s.sensorUnit}>bpm</Text></Text>
          <BtnPrimary label="📡 MESURER FC" onPress={requestHR} />
        </View>

        <View style={s.sensorCard}>
          <Text style={[s.sensorTitle, { color: C.cyan }]}>🩺 SATURATION SPO2</Text>
          <Text style={[s.sensorBig, { color: C.cyan }]}>{sensors.spo2} <Text style={s.sensorUnit}>%</Text></Text>
          <View style={s.spo2Bar}><View style={[s.spo2Fill, { width: (parseFloat(sensors.spo2)||0)+'%' }]} /></View>
          <BtnPrimary label="📡 MESURER SPO2" onPress={requestSpo2} />
        </View>

        <View style={s.sensorCard}>
          <Text style={[s.sensorTitle, { color: C.orange }]}>🦶 PODOMÈTRE</Text>
          <Text style={[s.sensorBig, { color: C.orange }]}>{sensors.steps}</Text>
          <Text style={s.sensorSub}>Objectif : 10 000 pas</Text>
          <BtnPrimary label="📡 ACTUALISER" onPress={requestSteps} />
        </View>

        <View style={s.sensorCard}>
          <Text style={[s.sensorTitle, { color: C.green }]}>🔋 BATTERIE</Text>
          <Text style={[s.sensorBig, { color: C.green }]}>{sensors.bat} <Text style={s.sensorUnit}>%</Text></Text>
          <BtnPrimary label="📡 LIRE BATTERIE" onPress={requestBat} />
        </View>

        <View style={s.sensorCard}>
          <Text style={[s.sensorTitle, { color: C.dim }]}>📋 DERNIÈRE TRAME RX</Text>
          <Text style={s.rawHex}>{lastRx}</Text>
        </View>
      </View>
    );
  }

  /* ═══════════════ SETTINGS ═══════════════ */
  function SettingsScreen() {
    return (
      <View style={{ padding: 16 }}>
        <SectionTitle title="⚙️ Paramètres Montre" />

        <SettingRow icon="🕐" title="Synchroniser l'heure" sub="Envoi heure locale → montre"
          right={<TouchableOpacity onPress={syncTime} style={s.settBtn}><Text style={s.settBtnTx}>SYNC</Text></TouchableOpacity>} />

        <SettingRow icon="❤️" title="FC continue 24h" sub="Mesure automatique"
          right={<Switch value={hr24} onValueChange={v => { setHr24(v); nusSend(buildPkt(CMD.HR_REALTIME, [v?0x01:0x00])); }} trackColor={{ false: C.bg3, true: C.green+'44' }} thumbColor={hr24 ? C.green : C.dim} />} />

        <SettingRow icon="📲" title="Notifications" sub="Transfert alertes"
          right={<Switch value={notifOn} onValueChange={setNotifOn} trackColor={{ false: C.bg3, true: C.cyan+'44' }} thumbColor={notifOn ? C.cyan : C.dim} />} />

        <SettingRow icon="🧍" title="Rappel sédentarité" sub="Alerte si inactif > 60 min"
          right={<Switch value={sedOn} onValueChange={v => { setSedOn(v); nusSend(buildPkt(CMD.SEDENTARY, [v?0x01:0x00, 0x3C])); }} trackColor={{ false: C.bg3, true: C.orange+'44' }} thumbColor={sedOn ? C.orange : C.dim} />} />

        <SettingRow icon="🔋" title="Batterie" sub="Lire niveau" right={<TouchableOpacity onPress={requestBat} style={s.settBtn}><Text style={s.settBtnTx}>LIRE</Text></TouchableOpacity>} />

        <SectionTitle title="🔧 Console NUS Brute" />
        <TextInput style={s.input} value={rawHex} onChangeText={setRawHex}
          placeholder="HEX ex: CD 01 00 00" placeholderTextColor={C.dim}
          autoCapitalize="characters" autoCorrect={false} />
        <TouchableOpacity style={[s.btnBase, { backgroundColor: C.purple+'22', borderColor: C.purple }]} onPress={sendRaw}>
          <Text style={[s.btnTx, { color: C.purple }]}>📡 ENVOYER HEX</Text>
        </TouchableOpacity>
        <Text style={s.rawHex}>{lastRx}</Text>
      </View>
    );
  }

  /* ═══════════════ MODALS ═══════════════ */
  function ConnectModal() {
    return (
      <View style={s.modalOverlay}>
        <View style={s.modalSheet}>
          <View style={s.handle} />
          <Text style={s.modalTitle}>📡 Connexion T800 Ultra</Text>

          {connState === 'scanning' && (
            <View style={{ alignItems: 'center', padding: 20 }}>
              <ActivityIndicator size="large" color={C.cyan} />
              <Text style={[s.sub, { marginTop: 12 }]}>Scan en cours... (10s)</Text>
            </View>
          )}

          {connState === 'connecting' && (
            <View style={{ alignItems: 'center', padding: 20 }}>
              <ActivityIndicator size="large" color={C.orange} />
              <Text style={[s.sub, { marginTop: 12, color: C.orange }]}>Connexion GATT...</Text>
            </View>
          )}

          {(connState === 'disconnected') && scanList.length === 0 && (
            <Text style={s.sub}>Appuie sur Rechercher pour détecter la montre. Assure-toi que T800ULTRA est allumée.</Text>
          )}

          {scanList.map(dev => (
            <TouchableOpacity key={dev.id} style={s.deviceItem} onPress={() => connectTo(dev)}>
              <Text style={{ fontSize: 20 }}>⌚</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.deviceName}>{dev.name}</Text>
                <Text style={s.deviceAddr}>{dev.id}</Text>
              </View>
              <Text style={s.deviceRssi}>{dev.rssi} dBm</Text>
            </TouchableOpacity>
          ))}

          <View style={{ height: 12 }} />
          <TouchableOpacity style={[s.btnBase, s.btnPrimary]} onPress={startScan}>
            <Text style={[s.btnTx, { color: C.bg }]}>🔍 RECHERCHER</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btnBase, { marginTop: 8 }]} onPress={() => setModal(null)}>
            <Text style={s.btnTx}>FERMER</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  function NotifModal() {
    return (
      <View style={s.modalOverlay}>
        <View style={s.modalSheet}>
          <View style={s.handle} />
          <Text style={s.modalTitle}>📲 Envoyer une Notification</Text>
          <TextInput style={s.input} value={notifTitle} onChangeText={setNotifTitle}
            placeholder="Titre (ex: Labo, Urgence...)" placeholderTextColor={C.dim} maxLength={25} />
          <TextInput style={[s.input, { height: 80 }]} value={notifBody} onChangeText={setNotifBody}
            placeholder="Message à afficher sur la montre..." placeholderTextColor={C.dim}
            multiline maxLength={60} />
          <Text style={[s.sub, { marginBottom: 12 }]}>Max 60 caractères · La montre vibre à réception</Text>
          <TouchableOpacity style={[s.btnBase, s.btnPrimary]} onPress={sendNotif}>
            <Text style={[s.btnTx, { color: C.bg }]}>📡 ENVOYER SUR LA MONTRE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btnBase, { marginTop: 8 }]} onPress={() => setModal(null)}>
            <Text style={s.btnTx}>ANNULER</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  function AlarmModal() {
    const alarms = [
      { h:6, m:30, label:'Réveil' },
      { h:13, m:0, label:'Déjeuner' },
      { h:22, m:0, label:'Sommeil' },
    ];
    const [states, setStates] = useState([true, false, true]);
    return (
      <View style={s.modalOverlay}>
        <View style={s.modalSheet}>
          <View style={s.handle} />
          <Text style={s.modalTitle}>⏰ Alarmes</Text>
          {alarms.map((a, i) => (
            <View key={i} style={s.alarmItem}>
              <View style={{ flex: 1 }}>
                <Text style={s.alarmTime}>{pad(a.h)}:{pad(a.m)}</Text>
                <Text style={s.alarmLabel}>{a.label}</Text>
              </View>
              <Switch value={states[i]}
                onValueChange={v => {
                  const ns = [...states]; ns[i] = v; setStates(ns);
                  nusSend(buildAlarmPkt(a.h, a.m, v));
                }}
                trackColor={{ false: C.bg3, true: C.green+'44' }} thumbColor={states[i] ? C.green : C.dim} />
            </View>
          ))}
          <TouchableOpacity style={[s.btnBase, s.btnSuccess, { marginTop: 12 }]}
            onPress={() => { alarms.forEach((a,i) => nusSend(buildAlarmPkt(a.h,a.m,states[i]))); setModal(null); }}>
            <Text style={[s.btnTx, { color: C.green }]}>📡 SYNC TOUTES</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btnBase, { marginTop: 8 }]} onPress={() => setModal(null)}>
            <Text style={s.btnTx}>FERMER</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  function ChronoModal() {
    return (
      <View style={s.modalOverlay}>
        <View style={s.modalSheet}>
          <View style={s.handle} />
          <Text style={s.modalTitle}>⏱️ Chronomètre</Text>
          <Text style={s.chronoDisp}>{chronoStr()}</Text>
          <View style={{ flexDirection:'row', gap:10, justifyContent:'center' }}>
            <TouchableOpacity style={[s.btnBase, chronoRunning ? s.btnDanger : s.btnPrimary, { flex:1 }]}
              onPress={() => setChronoRunning(r => !r)}>
              <Text style={[s.btnTx, { color: chronoRunning ? C.red : C.bg }]}>{chronoRunning ? 'PAUSE' : 'DÉMARRER'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btnBase, { flex:1 }]}
              onPress={() => { setChronoRunning(false); setChrono(0); }}>
              <Text style={s.btnTx}>RESET</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={[s.btnBase, s.btnSuccess, { marginTop: 10 }]}
            onPress={() => { const sec = Math.floor(chrono/1000); nusSend(buildPkt(0x50,[0x01,(sec>>8)&0xFF,sec&0xFF])); }}>
            <Text style={[s.btnTx, { color: C.green }]}>📡 ENVOYER SUR MONTRE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btnBase, { marginTop: 8 }]} onPress={() => setModal(null)}>
            <Text style={s.btnTx}>FERMER</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  /* ── Composants partagés ── */
  function SectionTitle({ title }) {
    return <Text style={s.secTitle}>{title}</Text>;
  }
  function BtnPrimary({ label, onPress }) {
    return (
      <TouchableOpacity style={[s.btnBase, s.btnPrimary, { marginTop: 12 }]} onPress={onPress}>
        <Text style={[s.btnTx, { color: C.bg }]}>{label}</Text>
      </TouchableOpacity>
    );
  }
  function SettingRow({ icon, title, sub, right }) {
    return (
      <View style={s.settRow}>
        <Text style={{ fontSize: 18, width: 28 }}>{icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={s.settTitle}>{title}</Text>
          <Text style={s.settSub}>{sub}</Text>
        </View>
        {right}
      </View>
    );
  }
}

/* ════════════════════════════════════
   STYLES
════════════════════════════════════ */
const s = StyleSheet.create({
  root: { flex:1, backgroundColor:C.bg },
  header: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', padding:18, paddingTop:50, borderBottomWidth:1, borderBottomColor:C.border, backgroundColor:C.bg },
  logo: { fontFamily:'monospace', fontSize:18, fontWeight:'900', color:C.cyan, letterSpacing:2 },
  badge: { flexDirection:'row', alignItems:'center', gap:6, paddingHorizontal:10, paddingVertical:5, borderRadius:20, borderWidth:1 },
  badgeConn:  { borderColor:C.green },
  badgeConn2: { borderColor:C.orange },
  badgeDisc:  { borderColor:C.dim },
  dot: { width:7, height:7, borderRadius:4 },
  badgeText: { fontFamily:'monospace', fontSize:11 },

  watchCard: { margin:16, backgroundColor:C.card, borderWidth:1, borderColor:C.border, borderRadius:20, padding:16, flexDirection:'row', gap:16 },
  watchFace: { width:80, height:96, borderRadius:22, borderWidth:2, alignItems:'center', justifyContent:'center' },
  wfTime: { fontFamily:'monospace', fontSize:15, fontWeight:'700' },
  wfDate: { fontFamily:'monospace', fontSize:8, color:'rgba(255,255,255,0.5)', marginTop:2 },
  watchModel: { fontFamily:'monospace', fontSize:13, fontWeight:'700', color:C.cyan },
  watchAddr: { fontFamily:'monospace', fontSize:9, color:C.dim, marginTop:2 },
  statsGrid: { flexDirection:'row', flexWrap:'wrap', gap:6, marginTop:8 },
  statItem: { backgroundColor:'rgba(0,229,255,0.05)', borderWidth:1, borderColor:C.border, borderRadius:8, padding:6, width:'46%' },
  statLabel: { fontSize:9, color:C.dim, fontFamily:'monospace' },
  statVal: { fontFamily:'monospace', fontSize:14, fontWeight:'700', marginTop:1 },

  nusLog: { marginHorizontal:16, marginTop:8, backgroundColor:'#000510', borderWidth:1, borderColor:C.border, borderRadius:10, padding:8 },
  nusLine: { fontFamily:'monospace', fontSize:9, lineHeight:16 },

  secTitle: { fontFamily:'monospace', fontSize:11, color:C.cyan, letterSpacing:3, paddingHorizontal:16, paddingVertical:12 },

  themesGrid: { flexDirection:'row', gap:8, paddingHorizontal:16, marginBottom:4 },
  themeCard: { flex:1, aspectRatio:0.8, borderRadius:12, borderWidth:1, borderColor:C.border, alignItems:'center', justifyContent:'center' },
  themeDot: { width:18, height:18, borderRadius:9, shadowOpacity:0.8, shadowRadius:6, elevation:4 },
  themeLabel: { fontFamily:'monospace', fontSize:7, color:'rgba(255,255,255,0.8)', marginTop:4 },

  appsGrid: { flexDirection:'row', flexWrap:'wrap', gap:10, paddingHorizontal:16 },
  appCard: { width:'47%', backgroundColor:C.card, borderWidth:1, borderColor:C.border, borderRadius:14, padding:14, overflow:'hidden' },
  appAccent: { position:'absolute', top:0, left:0, right:0, height:2 },
  appIcon: { fontSize:24, marginBottom:6 },
  appName: { fontFamily:'monospace', fontSize:10, fontWeight:'700', color:C.text },
  appDesc: { fontSize:10, color:C.dim, marginTop:2 },
  appStatus: { fontFamily:'monospace', fontSize:9, marginTop:6 },

  sensorCard: { backgroundColor:C.card, borderWidth:1, borderColor:C.border, borderRadius:16, padding:18, marginBottom:12 },
  sensorTitle: { fontFamily:'monospace', fontSize:11, marginBottom:8 },
  sensorBig: { fontFamily:'monospace', fontSize:36, fontWeight:'900', textAlign:'center' },
  sensorUnit: { fontSize:14, color:C.dim },
  sensorSub: { fontSize:11, color:C.dim, textAlign:'center', marginTop:4 },
  spo2Bar: { height:8, backgroundColor:C.bg3, borderRadius:4, borderWidth:1, borderColor:C.border, overflow:'hidden', marginTop:8 },
  spo2Fill: { height:'100%', backgroundColor:C.cyan, borderRadius:4 },
  rawHex: { fontFamily:'monospace', fontSize:10, backgroundColor:C.bg3, borderWidth:1, borderColor:C.border, borderRadius:8, padding:10, marginTop:8, color:C.green },

  settRow: { flexDirection:'row', alignItems:'center', backgroundColor:C.card, borderWidth:1, borderColor:C.border, borderRadius:12, padding:14, gap:10, marginBottom:8 },
  settTitle: { fontSize:13, fontWeight:'600', color:C.text },
  settSub: { fontSize:10, color:C.dim, marginTop:1 },
  settBtn: { backgroundColor:C.cyan+'22', borderWidth:1, borderColor:C.cyan, borderRadius:8, paddingHorizontal:12, paddingVertical:6 },
  settBtnTx: { fontFamily:'monospace', fontSize:11, color:C.cyan },

  input: { backgroundColor:C.bg3, borderWidth:1, borderColor:C.border, borderRadius:10, padding:12, color:C.text, fontFamily:'monospace', fontSize:13, marginBottom:8 },

  btnBase: { padding:13, borderRadius:25, borderWidth:1, borderColor:C.border, backgroundColor:C.cyan+'15', alignItems:'center' },
  btnPrimary: { backgroundColor:C.cyan, borderColor:C.cyan },
  btnDanger: { backgroundColor:C.red+'22', borderColor:C.red },
  btnSuccess: { backgroundColor:C.green+'15', borderColor:C.green },
  btnTx: { fontFamily:'monospace', fontSize:12, fontWeight:'700', color:C.cyan, letterSpacing:1 },

  modalOverlay: { position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,5,15,0.92)', justifyContent:'flex-end' },
  modalSheet: { backgroundColor:C.bg2, borderTopLeftRadius:24, borderTopRightRadius:24, borderWidth:1, borderColor:C.border, padding:22, paddingBottom:40, maxHeight:'85%' },
  handle: { width:40, height:4, backgroundColor:C.border, borderRadius:2, alignSelf:'center', marginBottom:18 },
  modalTitle: { fontFamily:'monospace', fontSize:16, fontWeight:'700', color:C.cyan, marginBottom:16 },

  deviceItem: { flexDirection:'row', alignItems:'center', backgroundColor:C.bg3, borderWidth:1, borderColor:C.border, borderRadius:12, padding:14, marginBottom:8 },
  deviceName: { fontSize:13, fontWeight:'600', color:C.text },
  deviceAddr: { fontFamily:'monospace', fontSize:10, color:C.dim },
  deviceRssi: { fontFamily:'monospace', fontSize:10, color:C.dim },

  alarmItem: { flexDirection:'row', alignItems:'center', backgroundColor:'rgba(0,229,255,0.04)', borderWidth:1, borderColor:C.border, borderRadius:12, padding:14, marginBottom:8 },
  alarmTime: { fontFamily:'monospace', fontSize:22, fontWeight:'700', color:C.text },
  alarmLabel: { fontSize:11, color:C.dim },

  chronoDisp: { fontFamily:'monospace', fontSize:44, fontWeight:'900', color:C.cyan, textAlign:'center', paddingVertical:20 },

  nav: { position:'absolute', bottom:0, left:0, right:0, flexDirection:'row', backgroundColor:'rgba(0,8,20,0.97)', borderTopWidth:1, borderTopColor:C.border, paddingBottom:20, paddingTop:8 },
  navItem: { flex:1, alignItems:'center', gap:3 },
  navIcon: { fontSize:20 },
  navLabel: { fontFamily:'monospace', fontSize:8, textTransform:'uppercase', letterSpacing:1 },
  sub: { fontFamily:'monospace', fontSize:11, color:C.dim, lineHeight:18 },
});
