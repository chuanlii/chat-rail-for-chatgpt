/** 弹窗只负责读写 chrome.storage.sync；内容脚本通过 storage.onChanged 实时生效。 */
const DEFAULTS = { enabled: true, side: 'auto', offset: 8, tipSide: 'left' };
const FIELDS = ['enabled', 'side', 'offset', 'tipSide'];

const el = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (v) => {
  el('enabled').checked = !!v.enabled;
  el('side').value = v.side;
  el('tipSide').value = v.tipSide;
  el('offset').value = String(v.offset);
  el('offsetVal').textContent = String(v.offset);
});

for (const name of FIELDS) {
  const input = el(name);
  input.addEventListener('input', () => {
    const value = name === 'enabled' ? input.checked : name === 'offset' ? Number(input.value) : input.value;
    chrome.storage.sync.set({ [name]: value });
    if (name === 'offset') el('offsetVal').textContent = String(value);
  });
}
