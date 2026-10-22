/* Núcleo puro, compartilhado pelo Apps Script e pelos testes. Sem acesso à rede. */
var LaudosCore = (() => {
  'use strict';
  const LEDGER_HEADERS = ['schema_version', 'event_id', 'event_type', 'created_at', 'issuer_id', 'os',
    'version_id', 'previous_version_id', 'request_id', 'snapshot_json', 'snapshot_sha256',
    'private_pdf_id', 'private_pdf_sha256', 'token_hash', 'projection_json', 'projection_signature',
    'key_id', 'previous_event_hash', 'event_hash', 'event_hmac', 'reason', 'replacement_version_id'];
  const INDEX_HEADERS = ['token_hash', 'projection_json', 'projection_signature', 'key_id', 'event_hash'];
  const MAP = Object.freeze({ os: 'C2', customerName: 'E5', date: 'C10', trt: 'H10',
    labor: 'D21', total: 'I21', technical: 'A24' });
  const EQUIPMENT_KEYS = ['tipo', 'quantidade', 'marca', 'modelo', 'numeroSerie', 'defeitoInformado'];
  function requireThat(condition, message) { if (!condition) throw new Error(message); }
  function text(value, label, max = 4000) {
    requireThat(typeof value === 'string' && value.length <= max, 'Texto inválido: ' + label);
    requireThat(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'Controle inválido: ' + label);
    return value;
  }
  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  function field(cell, label, required = true) {
    requireThat(cell && Object.hasOwnProperty.call(cell, 'value'), 'Célula ausente: ' + label);
    const display = text(cell.display, label);
    requireThat(!required || display.trim() !== '', 'Campo obrigatório: ' + label);
    requireThat(!/^#(?:REF!|N\/A|N\/D|VALUE!|VALOR!|DIV\/0!|ERROR!|ERRO!|NAME\?|NOME\?|NUM!|NÚM!|SPILL!|CALC!)/i.test(display.trim()), 'Erro de fórmula: ' + label);
    requireThat(['string', 'number', 'boolean'].includes(typeof cell.value), 'Valor não suportado: ' + label);
    if (typeof cell.value === 'number') requireThat(Number.isFinite(cell.value), 'Número inválido: ' + label);
    return { value: cell.value, display };
  }
  function cents(cell, label, optional = false) {
    field(cell, label, !optional);
    if (optional && cell.display.trim() === '' && cell.value === '') return null;
    requireThat(typeof cell.value === 'number' && cell.value >= 0, 'Esperado valor monetário numérico: ' + label);
    const result = Math.round(cell.value * 100);
    requireThat(Number.isSafeInteger(result) && Math.abs(cell.value * 100 - result) < 0.000001,
      'Precisão monetária diferente de centavos: ' + label);
    return result;
  }
  function parseTrt(cell, settings) {
    field(cell, 'TRT', false);
    const raw = cell.display;
    if (raw.trim() === '') return { raw, number: null };
    requireThat(typeof cell.value === 'string', 'TRT deve estar armazenado como texto; não reconstruir zeros perdidos.');
    requireThat(settings && settings.confirmed === true && typeof settings.pattern === 'string',
      'Formato de H10 não confirmado; registro bloqueado.');
    requireThat(settings.pattern.startsWith('^') && settings.pattern.endsWith('$') && settings.pattern.length <= 200,
      'Padrão TRT deve ser curto e ancorado.');
    const match = new RegExp(settings.pattern, 'u').exec(raw);
    requireThat(match && match[0] === raw && match.length === 2 && typeof match[1] === 'string' && match[1].length > 0 && match[1].length <= 80,
      'H10 não corresponde ao formato confirmado com um grupo de captura.');
    return { raw, number: match[1] };
  }
  function resolveFieldCells(mapping) {
    // Sem fieldCells, preservar exatamente o layout legado e seu digest.
    const fields = mapping.fieldCells === undefined ? MAP : mapping.fieldCells;
    const updated = { ...MAP, customerName: 'D5', date: 'B10' };
    requireThat(fields && !Array.isArray(fields) && typeof fields === 'object' &&
      [canonical(MAP), canonical(updated)].includes(canonical(fields)),
      'Mapa geral fora dos layouts confirmados E5/C10 ou D5/B10.');
    return { ...fields };
  }
  function assertMapping(mapping) {
    requireThat(mapping && mapping.confirmed === true && mapping.currency === 'BRL',
      'Mapeamento/moeda pendentes; use apenas o cenário fictício confirmado.');
    requireThat(Array.isArray(mapping.codeCells) && mapping.codeCells.length === 4, 'Confirmar as quatro células/mesclagens de código.');
    const address = /^[A-Z]{1,3}[1-9]\d{0,4}(?::[A-Z]{1,3}[1-9]\d{0,4})?$/;
    mapping.codeCells.forEach(a => requireThat(typeof a === 'string' && address.test(a), 'Intervalo de código inválido.'));
    requireThat(mapping.equipmentCells && Object.keys(mapping.equipmentCells).length > 0, 'Confirmar células do equipamento.');
    Object.keys(mapping.equipmentCells).forEach(k => requireThat(EQUIPMENT_KEYS.includes(k) && address.test(mapping.equipmentCells[k]), 'Campo de equipamento inválido.'));
    requireThat(typeof mapping.version === 'string' && mapping.version.length > 0, 'Versão do mapeamento ausente.');
    resolveFieldCells(mapping);
  }
  function buildSnapshot(capture, mapping) {
    assertMapping(mapping);
    const f = capture.fields;
    const equipment = {};
    const equipmentValues = {};
    for (const k of Object.keys(mapping.equipmentCells)) {
      const captured = field(capture.equipment[k], 'equipamento.' + k);
      if (k === 'quantidade') requireThat(typeof captured.value === 'number' && Number.isSafeInteger(captured.value) && captured.value > 0,
        'Quantidade de equipamentos deve ser um inteiro positivo.');
      equipmentValues[k] = captured;
      equipment[k] = captured.display;
    }
    requireThat(Array.isArray(capture.parts) && capture.parts.length === 4, 'Esperadas quatro posições de peças.');
    const parts = capture.parts.map((p, index) => {
      const sourceRow = index + 17;
      const entries = ['quantity', 'description', 'code', 'unitPrice', 'subtotal'];
      entries.forEach(k => field(p[k], 'peça.' + sourceRow + '.' + k, false));
      const emptyIdentity = ['quantity','description','code'].every(k => p[k].display.trim() === '' && p[k].value === '');
      const emptyAmounts = ['unitPrice','subtotal'].every(k => p[k].value === '' || p[k].value === 0);
      const capturedCells = Object.fromEntries(entries.map(k => [k, field(p[k], 'peça.' + sourceRow + '.' + k, false)]));
      if (emptyIdentity && emptyAmounts) return { sourceRow, present: false, quantity: null, description: '', code: '',
        unitPrice: p.unitPrice.value === 0 ? { cents: 0, display: p.unitPrice.display } : null,
        subtotal: p.subtotal.value === 0 ? { cents: 0, display: p.subtotal.display } : null, capturedCells };
      const quantity = field(p.quantity, 'quantidade ' + sourceRow);
      requireThat(typeof quantity.value === 'number' && quantity.value > 0 && Number.isFinite(quantity.value), 'Quantidade deve ser positiva.');
      const unitPrice = { cents: cents(p.unitPrice, 'unitário ' + sourceRow), display: p.unitPrice.display };
      const subtotal = { cents: cents(p.subtotal, 'subtotal ' + sourceRow), display: p.subtotal.display };
      return { sourceRow, present: true, quantity, description: field(p.description, 'descrição ' + sourceRow).display, capturedCells,
        code: field(p.code, 'código ' + sourceRow).display, unitPrice, subtotal };
    });
    const labor = { cents: cents(f.labor, 'mão de obra'), display: f.labor.display };
    const total = { cents: cents(f.total, 'total'), display: f.total.display };
    const calculatedPartsCents = parts.reduce((sum, p) => sum + (p.present ? p.subtotal.cents : 0), 0);
    requireThat(Number.isSafeInteger(calculatedPartsCents) && Number.isSafeInteger(calculatedPartsCents + labor.cents), 'Soma fora da faixa suportada.');
    const findings = [];
    if (equipmentValues.quantidade && equipmentValues.quantidade.value > 1) findings.push('Mais de um equipamento: conferir a correspondência de marca, modelo, série e defeito; a linha 13 não contém identidades individuais adicionais.');
    for (const p of parts.filter(p => p.present)) {
      if (Math.abs(p.quantity.value * p.unitPrice.cents - p.subtotal.cents) > 0.000001) findings.push('Linha ' + p.sourceRow + ': quantidade × unitário difere do subtotal.');
    }
    if (calculatedPartsCents + labor.cents !== total.cents) findings.push('Soma de peças e mão de obra difere do total declarado; confirmar descontos/acréscimos.');
    return { schemaVersion: 1, mappingVersion: mapping.version, currency: mapping.currency,
      os: field(f.os, 'OS').display, customerName: field(f.customerName, 'cliente').display,
      issueDate: field(f.date, 'data'), trt: parseTrt(f.trt, mapping.trt), equipment, equipmentValues,
      technicalDescription: field(f.technical, 'descrição técnica').display, parts, labor, declaredTotal: total,
      calculatedPartsCents, findings,
      sourceMap: { sheet: 'Laudo', fields: resolveFieldCells(mapping), codeCells: mapping.codeCells.slice(), equipmentCells: { ...mapping.equipmentCells },
        quantity: 'A17:A20', description: 'B17:B20', unitPrice: 'F17:F20', subtotal: 'I17:I20' } };
  }
  function checkPublicText(value) {
    const s = text(value, 'projeção pública');
    requireThat(!/(?:\bCPF\b|\bCNPJ\b|\bCEP\b|\btelefone\b|\bendereço\b|\bcelular\b|\bWhatsApp\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\(\d{2}\)\s*\d{4,5}-\d{4})/iu.test(s),
      'Possível dado pessoal extra no texto público; revisar manualmente.');
    return s;
  }
  function projection(snapshot, meta) {
    requireThat(['VALIDO', 'SUBSTITUIDO', 'CANCELADO'].includes(meta.status), 'Estado inválido.');
    const p = { schemaVersion: 1, sandbox: meta.sandbox === undefined ? true : meta.sandbox, accessBinding: meta.accessBinding, versionId: meta.versionId, status: meta.status,
      registeredAt: meta.registeredAt, updatedAt: meta.updatedAt, os: snapshot.os,
      customerName: snapshot.customerName, issueDate: snapshot.issueDate.display,
      trt: snapshot.trt.number, equipment: { ...snapshot.equipment }, technicalDescription: snapshot.technicalDescription,
      parts: snapshot.parts.filter(p => p.present).map(p => ({ quantity: p.quantity.display, description: p.description,
        code: p.code, unitPrice: p.unitPrice.display, subtotal: p.subtotal.display })),
      labor: snapshot.labor.display, declaredTotal: snapshot.declaredTotal.display, currency: snapshot.currency };
    assertPublicProjection(p);
    return p;
  }
  function assertPublicProjection(p) {
    const keys = ['schemaVersion','sandbox','accessBinding','versionId','status','registeredAt','updatedAt','os','customerName',
      'issueDate','trt','equipment','technicalDescription','parts','labor','declaredTotal','currency'].sort();
    requireThat(p && canonical(Object.keys(p).sort()) === canonical(keys), 'Campos públicos não autorizados.');
    requireThat(p.schemaVersion === 1 && typeof p.sandbox === 'boolean' && p.currency === 'BRL', 'Tipo de emissão inválido.');
    requireThat(typeof p.accessBinding === 'string' && /^[a-f0-9]{64}$/.test(p.accessBinding), 'Vínculo de acesso ausente.');
    requireThat(['VALIDO','SUBSTITUIDO','CANCELADO'].includes(p.status), 'Estado público inválido.');
    requireThat(typeof p.versionId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(p.versionId), 'Versão inválida.');
    ['registeredAt','updatedAt'].forEach(k => requireThat(typeof p[k] === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p[k]), 'Data de registro inválida.'));
    ['os','customerName','issueDate','technicalDescription','labor','declaredTotal'].forEach(k => checkPublicText(p[k]));
    requireThat(p.trt === null || typeof p.trt === 'string', 'TRT inválido.');
    if (p.trt !== null) checkPublicText(p.trt);
    requireThat(p.equipment && !Array.isArray(p.equipment) && Object.keys(p.equipment).length > 0, 'Equipamento inválido.');
    for (const k of Object.keys(p.equipment)) {
      requireThat(EQUIPMENT_KEYS.includes(k), 'Campo de equipamento proibido.');
      checkPublicText(p.equipment[k]);
    }
    requireThat(Array.isArray(p.parts) && p.parts.length <= 4, 'Peças inválidas.');
    for (const part of p.parts) {
      requireThat(canonical(Object.keys(part).sort()) === canonical(['quantity','description','code','unitPrice','subtotal'].sort()), 'Campos de peça inválidos.');
      Object.values(part).forEach(checkPublicText);
    }
    requireThat(canonical(p).length <= 24000, 'Projeção excede limite.');
    return p;
  }
  function assertReservationKind(config, pending) {
    const expected = config.sandbox !== false;
    const actual = pending.sandbox === undefined ? true : pending.sandbox;
    requireThat(typeof actual === 'boolean' && actual === expected, 'O tipo de emissão mudou desde a preparação; preserve a reserva e revise o modo antes de finalizar.');
  }
  function validateToken(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token); }
  function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  function verificationUrl(base, token) {
    requireThat(typeof base === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d+)?\/[^?#]*\/$/i.test(base), 'URL pública deve usar HTTPS, terminar em / e não conter query/fragmento.');
    requireThat(validateToken(token), 'Token inválido.');
    return base + '#' + token;
  }
  function eventBody(row) {
    const body = {};
    LEDGER_HEADERS.forEach((k, i) => { if (!['event_hash','event_hmac'].includes(k)) body[k] = row[i]; });
    return body;
  }
  function cellString(value) { return typeof value === 'string' ? value : String(value); }
  return { supportsRealIssues: true, LEDGER_HEADERS, INDEX_HEADERS, MAP, requireThat, canonical, field, cents, parseTrt, assertMapping, resolveFieldCells,
    buildSnapshot, projection, assertPublicProjection, assertReservationKind, validateToken, safeEqual, verificationUrl, eventBody, cellString };
})();
if (typeof module !== 'undefined') module.exports = LaudosCore;
