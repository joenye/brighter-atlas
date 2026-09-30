// The landing page (/): the three tools, each a picture, its name, what it needs and where it works, a line
// on what it does and a way in; under them the game on Steam and the Discord; the fan-project line and the
// site's version at the foot.
import { memo, useEffect, useState } from 'react';
import { buildVersionLabel, buildInfoReady } from '../build-info.js';
import { PATHS, type Tool } from './paths.js';
import { navigate } from './router.js';
import { DiscordIcon, SteamIcon, ExternalIcon, DISCORD_URL, GAME_URL, STEAM_URL } from './icons.js';

// the site's version, as the tool switch names it
function Version() {
  const [label, setLabel] = useState(buildVersionLabel());
  useEffect(() => { void buildInfoReady.then(() => setLabel(buildVersionLabel())); }, []);
  return <span className="home-foot-version">{label}</span>;
}

const CARDS: { tool: Exclude<Tool, 'home'>; alt: string; needs: boolean; phone: boolean; desc: string; go: string }[] = [
  { tool: 'fashion', alt: 'Characters in Brighter Fashion, on the beach and in colour', needs: false, phone: true, go: 'Open Brighter Fashion',
    desc: 'Design a character and try on every weapon, shield, armour piece and cosmetic, in every tier and dye. Save your looks, share them, or take a picture on the beach.' },
  { tool: 'maps', alt: 'The Crenopolis piers in Brighter Maps, as a street map and from above', needs: false, phone: true, go: 'Open Brighter Maps',
    desc: 'The world map for every game update: every room and its name. Slide through the updates and watch the world grow.' },
  { tool: 'data', alt: 'A room of the game in 3D, in Brighter Data', needs: true, phone: false, go: 'Open Brighter Data',
    desc: 'Everything inside the game from your own game files: models, rooms in 3D, animations, pictures, sounds and text. It all stays on your computer.' },
];

export const Landing = memo(() => (
  <div className="home">
    <main className="home-main">
      <section className="home-intro">
        {/* (the game's own site, in a new tab) */}
        <h1>Your tools for <a className="home-game" href={GAME_URL} target="_blank" rel="noopener noreferrer">Brighter Shores</a></h1>
        <p>All run in your browser, with nothing to install.</p>
      </section>
      <section className="home-tools">
        {CARDS.map((c) => (
          // (a card is one link, moved to without a page load)
          <a key={c.tool} className="home-tool" data-tool={c.tool} href={PATHS[c.tool]}
            onClick={(e) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate(PATHS[c.tool]); }}>
            <span className="home-shot"><img src={`/landing/${c.tool}.webp`} alt={c.alt} loading="lazy" width={1200} height={750}
              onLoad={(e) => e.currentTarget.classList.add('in')} ref={(img) => { if (img?.complete && img.naturalWidth) img.classList.add('in'); }} /></span>
            <span className="home-text">
              <span className="home-head">
                <span className="home-badges">
                  <span className={`home-badge${c.needs ? ' need' : ''}`}>{c.needs ? 'Needs your game files' : 'No game files needed'}</span>
                  <span className="home-badge where">{c.phone ? 'Desktop & mobile' : 'Desktop only'}</span>
                </span>
              </span>
              <span className="home-desc">{c.desc}</span>
              <span className="home-go">{c.go} <span className="home-go-arrow" aria-hidden="true">→</span></span>
            </span>
          </a>
        ))}
      </section>
      <section className="home-links">
        {/* the game itself, on Steam (another site, in a new tab) */}
        <a className="home-steam" href={STEAM_URL} target="_blank" rel="noopener noreferrer">
          <SteamIcon size={22} />
          <span className="home-discord-text"><b>Play Brighter Shores</b><span>Free to play on Steam</span></span>
          <span className="home-discord-go"><ExternalIcon size={16} /></span>
        </a>
        <a className="home-discord" href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
          <DiscordIcon size={20} />
          <span className="home-discord-text"><b>Join the Brighter Atlas Discord</b><span>News of every update, ideas and help</span></span>
          <span className="home-discord-go" aria-hidden="true">→</span>
        </a>
      </section>
    </main>
    <footer className="home-foot">
      <div className="home-foot-in">
        <span className="home-foot-brand"><img src="/brand/mark.svg" alt="" width={16} height={16} /> <span><span className="brand-name">Brighter</span> <span className="brand-sub">Atlas</span></span></span>
        <span className="home-foot-note">A fan project. Not affiliated with or endorsed by Fen Research, the makers of Brighter Shores.</span>
        <Version />
      </div>
    </footer>
  </div>
));
