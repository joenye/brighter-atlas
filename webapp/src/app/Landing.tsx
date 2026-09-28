// The landing page (/): the three tools, each a picture, its name, what it needs and where it works, a line
// on what it does and a way in; the Discord under them; the fan-project line at the foot.
import { memo } from 'react';
import { PATHS, type Tool } from './paths.js';
import { navigate } from './router.js';
import { DiscordIcon, DISCORD_URL } from './icons.js';

const CARDS: { tool: Exclude<Tool, 'home'>; alt: string; needs: boolean; phone: boolean; desc: string; go: string }[] = [
  { tool: 'fashion', alt: 'Characters in Brighter Fashion, on the beach and in colour', needs: false, phone: true, go: 'Open Brighter Fashion',
    desc: 'Design a character and try on every weapon, shield, armour piece and cosmetic, in every tier and dye. Save your looks, share them, or take a picture on the beach.' },
  { tool: 'maps', alt: 'The Crenopolis piers in Brighter Maps, as a street map and from above', needs: false, phone: true, go: 'Open the map',
    desc: 'The world map for every game update: every room and its name. Slide through the updates and watch the world grow.' },
  { tool: 'data', alt: 'A room of the game in 3D, in Brighter Data', needs: true, phone: false, go: 'Open Brighter Data',
    desc: 'Everything inside the game from your own game files: models, rooms in 3D, animations, pictures, sounds and text. It all stays on your computer.' },
];

export const Landing = memo(() => (
  <div className="home">
    <main className="home-main">
      <section className="home-intro">
        <h1>Fan-made tools for Brighter Shores</h1>
        <p>Try on every outfit, explore the world, and open everything in the game. All three run in your browser, with nothing to install.</p>
      </section>
      <section className="home-tools">
        {CARDS.map((c) => (
          // (a card is one link, moved to without a page load)
          <a key={c.tool} className="home-tool" data-tool={c.tool} href={PATHS[c.tool]}
            onClick={(e) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate(PATHS[c.tool]); }}>
            <span className="home-shot"><img src={`/landing/${c.tool}.webp`} alt={c.alt} loading="lazy" width={1200} height={750} /></span>
            <span className="home-text">
              <span className="home-head">
                <span className="home-name"><span className="brand-name">Brighter</span> <span className="brand-sub">{c.tool}</span></span>
                <span className="home-badges">
                  <span className={`home-badge${c.needs ? ' need' : ''}`}>{c.needs ? 'Needs your game files' : 'No game files needed'}</span>
                  <span className="home-badge where">{c.phone ? 'Desktop & mobile' : 'Desktop only'}</span>
                </span>
              </span>
              <span className="home-desc">{c.desc}</span>
              <span className="home-go">{c.go} <span aria-hidden="true">→</span></span>
            </span>
          </a>
        ))}
      </section>
      <a className="home-discord" href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
        <DiscordIcon size={20} />
        <span className="home-discord-text"><b>Join the Brighter Atlas Discord</b><span>News of every update, ideas and help</span></span>
        <span className="home-discord-go" aria-hidden="true">→</span>
      </a>
    </main>
    <footer className="home-foot">
      <span>A fan project. Not affiliated with or endorsed by Fen Research, the makers of Brighter Shores.</span>
    </footer>
  </div>
));
