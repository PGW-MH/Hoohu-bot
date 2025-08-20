import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.api, { headers: { 'user-agent': config.useragent } });

const TITLE = 'User:Hoohu-bot/timestamp';
const CONTENT = '~~~~~';
const SUMMARY = 'Daily timestamp print.';

async function pageEdit(title, content, summary) {
    await api
        .postWithToken(
            'csrf',
            {
                action: 'edit',
                title,
                text: content,
                summary,
                bot: true,
                tags: 'hoohu-daily',
                watchlist: 'nochange'
            },
            { retry: 10, noCache: true }
        )
        .then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
    console.log(`[${new Date().toISOString()}] Daily timestamp print started.`);
    await api.login(config.bot.name, config.bot.password);
    await pageEdit(TITLE, CONTENT, SUMMARY);
    console.log(`[${new Date().toISOString()}] Daily timestamp print completed.`);
})();
