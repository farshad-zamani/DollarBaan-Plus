// Applies the saved theme before first paint (loaded as a classic, blocking script).
(function () {
    try {
        var theme = localStorage.getItem('dollarbaan.theme');
        if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
        // DollarBaan Plus: start hidden when the app lock is on, so the empty shell never flashes before the lock screen.
        if (localStorage.getItem('dollarbaanplus.lock')) document.documentElement.classList.add('is-locked');
    } catch (error) {
        /* storage unavailable: follow the system theme */
    }
})();
