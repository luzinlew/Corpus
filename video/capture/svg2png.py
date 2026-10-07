import asyncio, sys, pathlib
from playwright.async_api import async_playwright
async def main(src, dst, w, h):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
        pg = await b.new_page(viewport={'width': w, 'height': h})
        await pg.goto(pathlib.Path(src).resolve().as_uri())
        await pg.screenshot(path=dst, type='jpeg', quality=92) if dst.endswith('.jpg') else await pg.screenshot(path=dst)
        await b.close()
asyncio.run(main(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])))
