import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const PGW_API = config.api;
const USER_AGENT = config.useragent;
const MAX_DEPTH = 20;

const OTHER_APIS = {
    vi: 'https://vi.wikipedia.org/w/api.php',
    zh: 'http://xyy.huijiwiki.com/api.php'
};

const pgwApi = new MediaWikiApi(PGW_API, { headers: { 'user-agent': USER_AGENT } });

function escapeRegex(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}
const allowedLangs = Object.keys(OTHER_APIS);
const langPattern = allowedLangs.map(escapeRegex).join('|');
const INTERLANG_RE_GLOBAL = new RegExp(`\\[\\[(?!:)((?:${langPattern})):([^\\]\\n]+?)\\]\\]`, 'gi');
const INTERLANG_REMOVE_RE = new RegExp(`\\[\\[(?!:)(?:${langPattern}):[^\\]\\n]+?\\]\\]`, 'gi');

function createRemoteApi(baseUrl) {
    const headers = { 'user-agent': USER_AGENT };

    if (baseUrl.includes('huijiwiki.com')) {
        const key = process.env.HUIJI_AUTHKEY;
        if (!key) {
            console.warn('HUIJI_AUTHKEY is required for huijiwiki API access but not found in environment variables.');
            return new MediaWikiApi(baseUrl, { headers });
        }
        headers['X-authkey'] = key;
    }

    return new MediaWikiApi(baseUrl, { headers });
}

async function tryCreateAndTestApi(baseUrl) {
    try {
        const api = createRemoteApi(baseUrl);
        const { data } = await api.get({ action: 'query', meta: 'siteinfo', format: 'json' }, { retry: 3 });
        if (!data) throw new Error('no siteinfo');
        return api;
    } catch (err) {
        if (baseUrl.startsWith('http://')) {
            const httpsUrl = 'https://' + baseUrl.slice('http://'.length);
            try {
                const api2 = createRemoteApi(httpsUrl);
                const { data } = await api2.get({ action: 'query', meta: 'siteinfo', format: 'json' }, { retry: 3 });
                if (!data) throw new Error('no siteinfo on https fallback');
                console.warn(`[WARN] ${baseUrl} probe failed; using HTTPS fallback ${httpsUrl}`);
                return api2;
            } catch (err2) {
                console.error(`[ERROR] Both HTTP and HTTPS probes failed for ${baseUrl}:`, err2?.message || err2);
                throw err2;
            }
        }
        throw err;
    }
}

async function getWithoutInterwikiTitles() {
    const { data } = await pgwApi.post(
        {
            list: 'querypage',
            qppage: 'Withoutinterwiki',
            qplimit: 'max',
            format: 'json'
        },
        { retry: 10 }
    );
    const results = data?.query?.querypage?.results || [];
    return new Set(results.map((r) => r.title));
}

async function getAllPgwNamespacePages() {
    const titles = [];
    let apcontinue;
    while (true) {
        const params = {
            action: 'query',
            list: 'allpages',
            apnamespace: 0,
            aplimit: 'max',
            format: 'json'
        };
        if (apcontinue) params.apcontinue = apcontinue;
        const { data } = await pgwApi.get(params, { retry: 10 });
        const pages = data?.query?.allpages || [];
        for (const p of pages) titles.push(p.title);
        if (data?.continue && data.continue.apcontinue) apcontinue = data.continue.apcontinue;
        else break;
    }
    return titles;
}

async function getPgwPageContent(title) {
    const { data } = await pgwApi.get(
        {
            action: 'query',
            titles: title,
            prop: 'revisions',
            rvprop: 'content',
            formatversion: 2,
            format: 'json'
        },
        { retry: 10 }
    );
    const page = (data?.query?.pages || [])[0];
    if (!page) return null;
    return page.revisions?.[0]?.content ?? '';
}

async function savePgwPageContent(title, newText, summary) {
    const body = {
        action: 'edit',
        title,
        text: newText,
        summary,
        bot: true,
        watchlist: 'nochange'
    };
    const { data } = await pgwApi.postWithToken('csrf', body, { retry: 10, noCache: true });
    return data;
}

async function queryRemoteFollowRedirects(api, title) {
    const { data } = await api.get(
        {
            action: 'query',
            titles: title,
            redirects: true,
            formatversion: 2,
            format: 'json'
        },
        { retry: 6 }
    );
    return data || {};
}

async function findRemoteMoveLogs(api, title) {
    const { data } = await api.get(
        {
            action: 'query',
            list: 'logevents',
            letype: 'move',
            letitle: title,
            lelimit: 'max',
            format: 'json'
        },
        { retry: 6 }
    );
    return data?.query?.logevents || [];
}

async function resolveFinalRemoteTitle(api, startTitle) {
    let current = startTitle;
    const seen = new Set();
    for (let i = 0; i < MAX_DEPTH; i++) {
        if (seen.has(current)) return null;
        seen.add(current);

        let q;
        try {
            q = await queryRemoteFollowRedirects(api, current);
        } catch (err) {
            console.error(`[ERROR] queryRemoteFollowRedirects failed for ${current}:`, err?.message || err);
            return null;
        }

        const redirects = q?.query?.redirects || [];
        const redirectEntry = redirects.find((r) => String(r.from).trim() === String(current).trim());
        if (redirectEntry) {
            current = String(redirectEntry.to).trim();
            continue;
        }

        const pages = q?.query?.pages || [];
        const page = pages[0];
        if (page && !page.missing) return current;

        let logs;
        try {
            logs = await findRemoteMoveLogs(api, current);
        } catch (err) {
            console.error(`[ERROR] findRemoteMoveLogs failed for ${current}:`, err?.message || err);
            return null;
        }
        if (logs && logs.length > 0) {
            let chosen = null;
            for (const ev of logs) {
                if (ev.params && Object.prototype.hasOwnProperty.call(ev.params, 'target_title')) {
                    chosen = ev;
                    break;
                }
            }
            if (chosen && chosen.params && chosen.params.target_title) {
                current = String(chosen.params.target_title).trim();
                continue;
            }
        }

        return null;
    }
    return null;
}

function extractFirstInterlangMap(content) {
    const map = new Map();
    let m;
    while ((m = INTERLANG_RE_GLOBAL.exec(content)) !== null) {
        const lang = m[1].toLowerCase();
        let raw = m[2].trim();

        if (raw.includes('|')) continue;

        let anchor = null;
        const hashIdx = raw.indexOf('#');
        if (hashIdx !== -1) {
            anchor = raw.slice(hashIdx + 1).trim();
            raw = raw.slice(0, hashIdx).trim();
        }
        if (!map.has(lang)) map.set(lang, { title: raw, anchor });
    }
    INTERLANG_RE_GLOBAL.lastIndex = 0;
    return map;
}

function removeAllInterlangsFromContent(content) {
    const lines = content.split(/\r?\n/);
    const newLines = [];
    for (let line of lines) {
        const cleaned = line.replace(INTERLANG_REMOVE_RE, '').replace(/\s+$/, '');
        if (cleaned.trim().length === 0) continue;
        newLines.push(cleaned);
    }
    return newLines.join('\n').trimEnd();
}

function buildFinalInterlangLine(finalMap) {
    const langs = Array.from(finalMap.keys()).sort();
    if (langs.length === 0) return '';
    const pieces = langs.map((l) => `[[${l}:${finalMap.get(l)}]]`);
    return pieces.join('');
}

async function processPage(title, remoteApisCache) {
    console.log(`Processing page: ${title}`);
    const content = await getPgwPageContent(title);
    if (content === null) {
        console.log(`  [SKIP] page not found: ${title}`);
        return;
    }

    const firstMap = extractFirstInterlangMap(content);
    if (firstMap.size === 0) {
        console.log(`  [SKIP] no interlang links for allowed langs on page.`);
        return;
    }

    const finalMap = new Map();
    const allowedSet = new Set(allowedLangs);

    for (const [lang, { title: initialBaseTitle, anchor }] of firstMap.entries()) {
        if (!allowedSet.has(lang)) continue;
        console.log(`  [CHECK] lang=${lang}, initial="${initialBaseTitle}", anchor=${anchor ?? '<none>'}`);
        let apiRemote = remoteApisCache[lang];
        if (!apiRemote) {
            const baseUrl = OTHER_APIS[lang];
            try {
                apiRemote = await tryCreateAndTestApi(baseUrl);
                remoteApisCache[lang] = apiRemote;
            } catch (err) {
                console.error(`    [ERROR] Could not create remote API for ${lang} (${baseUrl}), skipping this lang.`);
                continue;
            }
        }
        const finalBase = await resolveFinalRemoteTitle(apiRemote, initialBaseTitle);
        if (finalBase) {
            const finalWithAnchor = anchor ? `${finalBase}#${anchor}` : finalBase;
            finalMap.set(lang, finalWithAnchor);
            console.log(`    [FOUND] ${lang} -> ${finalWithAnchor}`);
        } else {
            console.log(`    [NOTFOUND] ${lang}:${initialBaseTitle} -> drop`);
        }
    }

    const cleaned = removeAllInterlangsFromContent(content);
    const finalLine = buildFinalInterlangLine(finalMap);
    const newContent = finalLine ? (cleaned ? `${cleaned}\n${finalLine}` : `${finalLine}`) : cleaned;

    if ((newContent || '').trim() === (content || '').trim()) {
        console.log(`  [NOCHANGE] page content unchanged -> skip editing.`);
        return;
    }

    console.log(`  [EDIT] saving updated interlang footer for ${title}`);
    try {
        await savePgwPageContent(title, newContent, 'Normalize and repair interlanguage links.');
        console.log(`  [OK] ${title} updated.`);
    } catch (err) {
        console.error(`  [ERROR] saving ${title}:`, err?.message || err);
    }
}

(async () => {
    console.log(`[${new Date().toISOString()}] interlang fix started.`);
    try {
        await pgwApi.login(config.bot.name, config.bot.password);
    } catch (err) {
        console.error('Login failed:', err?.message || err);
        process.exit(1);
    }

    const withoutSet = await getWithoutInterwikiTitles();
    console.log(`Withoutinterwiki count: ${withoutSet.size}`);

    const allPages = await getAllPgwNamespacePages();
    console.log(`Total main-namespace pages: ${allPages.length}`);

    // const toProcess = allPages.filter((t) => !withoutSet.has(t));
    const toProcess = ['User:Honoka55/test'];
    console.log(`Pages to process (after filtering): ${toProcess.length}`);

    const remoteApisCache = {};

    for (const title of toProcess) {
        try {
            await processPage(title, remoteApisCache);
        } catch (err) {
            console.error(`Fatal error processing ${title}:`, err?.message || err);
        }
    }

    console.log(`[${new Date().toISOString()}] interlang fix completed.`);
})();
