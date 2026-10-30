export function target(raw) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/qchat-connect#[a-f0-9]{64}$/.test(raw || '')) throw Error('Open a fresh QChat connect tab.');
  const u = new URL(raw); if (+u.port > 65535) throw Error('Invalid connect tab.');
  return {url: raw.split('#')[0], token: u.hash.slice(1)};
}
export function filterCookies(cookies) {
  return cookies.filter(c => /^__Secure-(next-auth|authjs)\.session-token(?:\.(?:0|[1-9][0-9]?))?$/.test(c.name) && ['chatgpt.com', '.chatgpt.com'].includes(c.domain) && c.path === '/' && !c.partitionKey && (c.expirationDate === undefined || c.expirationDate > Date.now()/1000)).map(({name,value,domain,path,expirationDate}) => ({name,value,domain,path,...(expirationDate === undefined ? {} : {expirationDate})}));
}
export const permissions = {permissions:['cookies'], origins:['https://chatgpt.com/*','http://127.0.0.1/*']};
export async function transfer(api, fetcher, selected, consent) {
  let t, cookies;
  try {
    if (!consent) throw Error('Consent required.');
    t = target(selected); selected = undefined;
    if (!await api.permissions.request(permissions)) throw Error('Permission denied.');
    cookies = filterCookies(await api.cookies.getAll({url:'https://chatgpt.com/'}));
    if (!cookies.length) throw Error('Sign into chatgpt.com in this browser, then return to the connect tab.');
    const response = await fetcher(t.url,{method:'POST',headers:{'Content-Type':'application/json','X-QChat-Token':t.token},body:JSON.stringify({cookies}),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Error('Import failed. Start a fresh connection in QChat.');
    return 'Session copied. QChat will check sign-in.';
  } catch(e) {
    if (e instanceof Error && /^(Consent required|Open a fresh|Invalid connect|Permission denied|Sign into|Import failed)/.test(e.message)) throw e;
    throw Error('Connection failed. Start a fresh connection in QChat.');
  } finally {
    if(t) t.token = ''; cookies = undefined; selected = undefined;
    try { await api.permissions.remove(permissions); } catch {}
  }
}
