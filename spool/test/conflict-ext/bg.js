// Behaves like many download managers and sniffers: listens for file name
// decisions and suggests nothing. Loaded after Spool by test/e2e.js, so it
// counts as installed last. Before 0.2.1 this made Spool's files lose
// their names.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => { suggest(); });
