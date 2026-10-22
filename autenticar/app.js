/* Não há analytics, armazenamento local, busca por OS ou carregamento de recursos de terceiros. */
(() => {
  'use strict';
  const config = window.SOS_CONFIG || {};
  const C = LaudosCore;
  const element = id => document.getElementById(id);
  function message(text) { element('message').textContent = text; }
  function hide() {
    element('result').hidden = true; element('gateway').hidden = true;
    element('open-viewer').removeAttribute('href');
    element('record-kind').textContent = 'Consulte os dados registrados e compare com o documento recebido.';
    element('record-kind').className = 'notice';
  }
  function pair(dl, label, value) {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    dl.append(dt, dd);
  }
  function clear(id) { element(id).replaceChildren(); }
  function render(p) {
    C.assertPublicProjection(p);
    ['identity','equipment','parts','totals'].forEach(clear);
    element('record-kind').textContent = p.sandbox ? 'AMBIENTE DE TESTE · DADOS FICTÍCIOS · SEM VALIDADE DOCUMENTAL' : 'DADOS REGISTRADOS NA EMISSÃO · COMPARE COM SEU DOCUMENTO';
    element('record-kind').className = p.sandbox ? 'prototype' : 'notice';
    const status = { VALIDO: [p.sandbox ? 'Registro de teste válido' : 'Registro válido', 'valid'], SUBSTITUIDO: ['Versão substituída — confira a emissão vigente com o emissor', 'replaced'], CANCELADO: ['Registro cancelado — não utilizar este laudo', 'cancelled'] }[p.status];
    element('status').textContent = status[0]; element('status').className = 'status ' + status[1];
    element('comparison-name').textContent = p.customerName;
    element('comparison-total').textContent = p.declaredTotal;
    const identity = element('identity');
    pair(identity, 'Cliente', p.customerName); pair(identity, 'OS', p.os); pair(identity, 'Data do laudo', p.issueDate);
    pair(identity, 'TRT', p.trt === null ? 'Não informado nesta emissão' : p.trt);
    pair(identity, 'Versão', p.versionId); pair(identity, 'Registrado em', new Date(p.registeredAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
    pair(identity, 'Situação atualizada em', new Date(p.updatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
    const labels = {tipo:'Tipo',quantidade:'Quantidade de equipamentos',marca:'Marca',modelo:'Modelo',numeroSerie:'Número de série',defeitoInformado:'Defeito informado'};
    for (const [key, value] of Object.entries(p.equipment)) pair(element('equipment'), labels[key], value);
    element('technical').textContent = p.technicalDescription;
    for (const part of p.parts) {
      const tr = document.createElement('tr');
      for (const [key, label] of [['quantity','Quantidade'],['description','Peça'],['code','Código'],['unitPrice','Preço unitário'],['subtotal','Subtotal']]) {
        const td = document.createElement('td'); td.textContent = part[key]; td.setAttribute('data-label', label); tr.append(td);
      }
      element('parts').append(tr);
    }
    element('empty-parts').hidden = p.parts.length !== 0;
    pair(element('totals'), 'Mão de obra', p.labor); pair(element('totals'), 'Total declarado', p.declaredTotal);
    element('result').hidden = false;
    message('Assinatura dos dados' + (p.sandbox ? ' de teste' : '') + ' conferida. Compare nome, valores e demais informações com o PDF recebido.');
  }
  function decode64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  async function validateEnvelope(envelope, token) {
    if (!envelope || envelope.available !== true) throw new Error('unavailable');
    if (typeof envelope.json !== 'string' || envelope.json.length > 24000 || typeof envelope.signature !== 'string' || envelope.signature.length > 1200) throw new Error('invalid');
    const key = config.trustedKeys && Object.hasOwn(config.trustedKeys, envelope.keyId) ? config.trustedKeys[envelope.keyId] : null;
    if (!key || !window.crypto || !window.crypto.subtle) throw new Error('untrusted');
    const imported = await window.crypto.subtle.importKey('spki', decode64(key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await window.crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, decode64(envelope.signature), new TextEncoder().encode(envelope.json));
    if (!valid) throw new Error('signature');
    const p = C.assertPublicProjection(JSON.parse(envelope.json));
    const hashBytes = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const binding = Array.from(new Uint8Array(hashBytes), b => b.toString(16).padStart(2, '0')).join('');
    if (!C.safeEqual(binding, p.accessBinding)) throw new Error('binding');
    return p;
  }
  function readFragment() {
    if (config.mode === 'apps-script') return new Promise((resolve, reject) => {
      try { google.script.url.getLocation(location => resolve(typeof location.hash === 'string' ? location.hash.replace(/^#/, '') : '')); } catch (_) { reject(new Error('location')); }
    });
    return Promise.resolve(window.location.hash.slice(1));
  }
  function lookup(token) {
    if (config.mode === 'apps-script') return new Promise((resolve, reject) => google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).consultarLaudo(token));
    if (config.mode !== 'demo') return Promise.reject(new Error('transport'));
    return fetch('/api/consulta', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token}), cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer' }).then(response => {
      if (!response.ok) throw new Error('request'); return response.json();
    });
  }
  function gateway(token) {
    // Não fazer fetch ao Web App: Apps Script não oferece um contrato CORS adequado para esta integração.
    const address = config.appScriptExecUrl;
    if (typeof address !== 'string' || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(address)) {
      message('Consulta ainda não configurada. Entre em contato com a SOS Televisores.'); return;
    }
    element('open-viewer').href = address + '#' + token;
    element('gateway').hidden = false;
    message('Abra a conferência para consultar os dados originais desta emissão.');
  }
  let generation = 0;
  async function start() {
    const own = ++generation;
    hide(); element('retry').hidden = true; message('Consultando registro…');
    // RPC do Google não é cancelável. Uma resposta tardia nunca substitui uma nova consulta.
    const timer = window.setTimeout(() => {
      if (own !== generation) return;
      generation++; hide(); element('retry').hidden = false;
      message('A consulta demorou mais que o esperado. Tente novamente. Isso não indica que o documento seja falso.');
    }, 20000);
    try {
      const token = await readFragment();
      if (own !== generation) return;
      if (!C.validateToken(token)) { message('Registro indisponível. Confira o link recebido com o emissor.'); return; }
      if (config.mode === 'gateway') { gateway(token); return; }
      const envelope = await lookup(token);
      const p = await validateEnvelope(envelope, token);
      if (own !== generation) return;
      render(p);
    } catch (_) {
      if (own !== generation) return;
      hide(); element('retry').hidden = false;
      message('Registro indisponível ou integridade não confirmada. Tente novamente ou consulte a SOS Televisores. Isso não indica, por si só, que o documento seja falso.');
    } finally {
      window.clearTimeout(timer);
    }
  }
  element('retry').addEventListener('click', start);
  window.addEventListener('hashchange', start);
  start();
})();
