import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.api, { headers: { 'user-agent': config.useragent } });
const MAX_DEPTH = 20;

function normalizeTitle(t) {
    return String(t).trim();
}

async function queryQueryPage(qppage) {
    const { data } = await api.post(
        {
            list: 'querypage',
            qppage,
            qplimit: 'max',
            format: 'json'
        },
        { retry: 10 }
    );
    return (data?.query?.querypage?.results || []).map((r) => normalizeTitle(r.title));
}

async function queryFollowRedirects(title) {
    const { data } = await api.get({
        action: 'query',
        titles: title,
        redirects: true,
        formatversion: 2,
        format: 'json'
    });
    return data?.query || {};
}

async function findMoveLogs(title) {
    const { data } = await api.get({
        action: 'query',
        list: 'logevents',
        letype: 'move',
        letitle: title,
        lelimit: 'max',
        format: 'json'
    });
    return data?.query?.logevents || [];
}

async function editPageText(title, text, summary) {
    const body = {
        action: 'edit',
        title,
        text,
        summary,
        bot: true,
        tags: 'hoohu-redirect',
        watchlist: 'nochange'
    };
    const { data } = await api.postWithToken('csrf', body, { retry: 10, noCache: true });
    return data;
}

async function resolveFinalTargetForOriginal(originalTitle) {
    const chain = [];
    const seen = new Set();
    let current = normalizeTitle(originalTitle);

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        if (seen.has(current)) {
            return { type: 'loop', chain: [...chain, current] };
        }
        seen.add(current);
        chain.push(current);

        let q;
        try {
            q = await queryFollowRedirects(current);
        } catch (err) {
            console.error(`Error querying redirects for "${current}":`, err?.message || err);
            return { type: 'error', chain };
        }

        const redirects = q.redirects || [];
        const redirectEntry = redirects.find((r) => normalizeTitle(r.from) === normalizeTitle(current));

        if (redirectEntry) {
            const next = normalizeTitle(redirectEntry.to);

            if (normalizeTitle(next) === normalizeTitle(originalTitle)) {
                return { type: 'self', chain: [...chain, next] };
            }

            current = next;
            continue;
        } else {
            const pages = q.pages || [];
            const page = pages[0];
            if (page && !page.missing) {
                return { type: 'exists', finalTitle: current, chain };
            }

            const logs = await findMoveLogs(current);
            if (logs && logs.length > 0) {
                let chosen = null;
                for (const ev of logs) {
                    if (ev.params && Object.prototype.hasOwnProperty.call(ev.params, 'target_title')) {
                        chosen = ev;
                        break;
                    }
                }
                if (chosen && chosen.params && chosen.params.target_title) {
                    current = normalizeTitle(chosen.params.target_title);
                    continue;
                }
            }

            return { type: 'missing', chain };
        }
    }

    return { type: 'maxdepth', chain };
}

async function main() {
    console.log(`[${new Date().toISOString()}] Redirect fix started.`);
    await api.login(config.bot.name, config.bot.password);

    const doubleList = await queryQueryPage('DoubleRedirects');
    const brokenList = await queryQueryPage('BrokenRedirects');

    const combined = Array.from(new Set([...doubleList, ...brokenList, 'User:Honoka55/test']));

    console.log('Combined list length (incl test):', combined.length);

    for (const title of combined) {
        try {
            console.log(`\n[PROCESS] Handling "${title}"`);

            const q0 = await queryFollowRedirects(title);
            const redirects0 = q0.redirects || [];
            const redirectEntry0 = redirects0.find((r) => normalizeTitle(r.from) === normalizeTitle(title));

            if (!redirectEntry0) {
                const page0 = (q0.pages || [])[0];
                if (page0 && !page0.missing) {
                    console.log(`[SKIP] "${title}" exists and is not a redirect → skip.`);
                    continue;
                }
            } else {
                const immediateTarget = normalizeTitle(redirectEntry0.to);
                if (immediateTarget === normalizeTitle(title)) {
                    console.log(`[SELF] "${title}" is a self-redirect. Replacing content with delete template.`);
                    await editPageText(title, '{{delete|Self-redirect.}}', 'Mark self-redirect for deletion.');
                    continue;
                }
            }

            const resolved = await resolveFinalTargetForOriginal(title);
            console.log(`[RESULT] "${title}" ->`, resolved);

            if (resolved.type === 'exists' && resolved.finalTitle) {
                const final = resolved.finalTitle;

                if (normalizeTitle(final) === normalizeTitle(title)) {
                    console.log(`[SELF2] "${title}" final equals itself; replacing with delete template.`);
                    await editPageText(title, '{{delete|Self-redirect.}}', 'Mark self-redirect for deletion.');
                } else {
                    console.log(`[FIX] "${title}" -> set redirect to final target "${final}"`);
                    await editPageText(title, `#REDIRECT [[${final}]]`, `Fix redirect → [[${final}]].`);
                }
            } else if (resolved.type === 'self') {
                console.log(`[SELF] "${title}" detected self-redirect in chain. Replacing with delete template.`);
                await editPageText(title, '{{delete|Self-redirect.}}', 'Mark self-redirect for deletion.');
            } else {
                console.log(`[DELETE] "${title}" has no resolvable final target. Replacing with delete template.`);
                await editPageText(title, '{{delete|Broken redirect.}}', 'Mark broken redirect for deletion.');
            }
        } catch (err) {
            console.error(`[ERROR] while processing "${title}":`, err?.message || err);
        }
    }

    console.log(`[${new Date().toISOString()}] Redirect fix completed.`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
