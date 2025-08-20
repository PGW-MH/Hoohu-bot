export default {
    api: 'https://xyy.miraheze.org/w/api.php',
    useragent: `${process.env.HOOHU_UA}`,
    bot: {
        name: 'Hoohu-bot',
        password: process.env.HOOHU_PASSWORD
    }
};
