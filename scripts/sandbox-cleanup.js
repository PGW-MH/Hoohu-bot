import moment from 'moment';
import { MediaWikiApi } from 'wiki-saikou';
import config from './utils/config.js';

const api = new MediaWikiApi(config.api, { headers: { 'user-agent': config.useragent } });

const PAGES = {
    'Pleasant Goat Wiki:Sandbox': {
        content: '<noinclude><!--DO NOT REMOVE THIS LINE-->{{sandbox top}}<!--PERFORM YOUR TEST BELOW--></noinclude>',
        summary: 'Sandbox cleanup. For long-term testing, please use [[Special:MyPage/sandbox|your personal sandbox]].'
    },
    'Template:Sandbox': {
        content: '<noinclude><!--DO NOT REMOVE THIS LINE-->{{sandbox top}}<!--PERFORM YOUR TEST BELOW--></noinclude>',
        summary: 'Sandbox cleanup. For long-term testing, please use [[Special:MyPage/sandbox|your personal sandbox]].'
    },
    'Module:Sandbox': {
        content: '',
        summary: 'Sandbox cleanup. For long-term testing, please use “Module:Sandbox/Your_username” or its subpages.'
    }
};

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
                tags: 'hoohu-sandbox',
                watchlist: 'nochange'
            },
            { retry: 10, noCache: true }
        )
        .then(({ data }) => console.log(JSON.stringify(data)));
}

(async () => {
    console.log(`[${new Date().toISOString()}] Sandbox cleanup started.`);
    await api.login(config.bot.name, config.bot.password);

    const {
        data: {
            query: { pages }
        }
    } = await api.post(
        {
            prop: 'revisions|info',
            titles: Object.keys(PAGES),
            rvprop: 'content|timestamp'
        },
        { retry: 10 }
    );

    for (const page of pages) {
        const title = page.title;
        const currentContent = page.revisions[0].content;
        const lastTouched = page.revisions[0].timestamp;

        if (PAGES[title].content !== currentContent) {
            const diffMinutes = moment().diff(moment(lastTouched), 'minutes');
            if (diffMinutes > 60) {
                console.log(`${title}: content differs, last edited ${diffMinutes} minutes ago → reset.`);
                await pageEdit(title, PAGES[title].content, PAGES[title].summary);
            } else {
                console.log(`${title}: edited recently (${diffMinutes} min ago) → skip.`);
            }
        } else {
            console.log(`${title}: no change.`);
        }
    }

    console.log(`[${new Date().toISOString()}] Sandbox cleanup completed.`);
})();
