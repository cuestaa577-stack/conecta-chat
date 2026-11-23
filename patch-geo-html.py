from pathlib import Path

# ---------------- HTML: pais + otro + aviso ----------------
h = Path('public/index.html')
s = h.read_text()

old = """      <label class="field"><span>Pais donde vives</span>
        <select id="authCountry">
          <option value="Venezuela">Venezuela</option>
          <option value="Chile">Chile</option>
          <option value="Ecuador">Ecuador</option>
          <option value="Colombia">Colombia</option>
          <option value="Peru">Perú</option>
          <option value="Argentina">Argentina</option>
          <option value="Otro">Otro</option>
        </select>
      </label>"""
new = """      <label class="field"><span>Pais donde vives actualmente</span>
        <select id="authCountry" onchange="App.countryChanged()">
          <option value="Venezuela">Venezuela</option>
          <option value="Chile">Chile</option>
          <option value="Ecuador">Ecuador</option>
          <option value="Otro">Otro pais</option>
        </select>
      </label>
      <label class="field hidden" id="authCountryOtherWrap"><span>Escribe tu pais</span>
        <input id="authCountryOther" type="text" placeholder="Nombre del pais" />
      </label>
      <p class="geo-hint" id="geoHint"></p>
      <p class="geo-alert hidden" id="geoAlert"></p>"""
assert s.count(old) == 1
s = s.replace(old, new)
h.write_text(s)
print('HTML: pais, otro y avisos')

# ---------------- CSS ----------------
c = Path('public/styles.css')
t = c.read_text()
anchor = ".mail-input {"
css = """.geo-hint { font-size: 12px; color: var(--muted); margin: -2px 0 8px; min-height: 0; }
.geo-hint b { color: var(--navy); }
.geo-alert {
  font-size: 12.5px; line-height: 1.45; color: #7a4a00; background: #fff6e5;
  border: 1px solid #f3d9a4; border-radius: 11px; padding: 10px 12px; margin: 0 0 10px;
}
"""
if '.geo-hint' not in t:
    t = t.replace(anchor, css + anchor)
c.write_text(t)
print('CSS: avisos de pais')
