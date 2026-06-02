# Allure

**Allure** est une petite application web installable (PWA) d'entraînement par
intervalles pour la course à pied. Tu composes une suite de segments
chronométrés (chacun = une catégorie + une durée), puis un minuteur fait le
décompte et **annonce chaque segment à voix haute** (synthèse vocale du
navigateur). Toute l'interface est en français.

> Esprit chaleureux et encourageant : la progression plutôt que la compétition.

---

## Fonctionnalités

- **Composeur** : catégories tappables (par défaut `marche`, `v1`, `v2`).
  Touche une catégorie pour ajouter un segment ; la durée se règle dans un
  **sélecteur in-app** (boutons −/+ par tranches de 15 s + raccourcis 0:30 →
  5:00). Réorganisation, édition (touche la durée d'un segment) et suppression.
- **Catégories éditables** : ajouter, renommer, recolorer, supprimer, et
  **associer un morceau de musique** à chacune.
- **Séquences enregistrées** (presets) + **export / import JSON**.
- **Boucle** de la séquence entière.
- **Écran de course** : grand décompte central, anneau de progression circulaire
  (SVG) qui pulse à chaque seconde, catégorie en cours + « Suivant : … »,
  Pause/Reprendre, Suivant, Précédent, Arrêter, et une **pluie de pétales** à la
  fin de la séance.
- **Annonces vocales en français** au début de chaque segment
  (« Marche, deux minutes »), avec choix de la voix.
- **Sons** optionnels : bips 3-2-1 avant chaque transition, carillon de
  transition et arpège de fin (un seul réglage « Sons »).
- **Ambiance sonore générative** (au premier plan, voir limites) : quatre
  morceaux entièrement **synthétisés dans l'app** (aucun fichier audio) —
  *Lever du jour*, *Asphalte*, *Néon*, *Récup* — un par catégorie, donc **la
  musique change selon le segment**. Tempo réglable **par morceau**, **métronome
  de cadence** optionnel, et la musique **baisse automatiquement (duck)** sous
  les annonces et carillons.
- **Vibration** à chaque changement de segment (repli silencieux).
- **Minuteur basé sur l'horloge** (timestamps) : il se corrige tout seul après
  une mise en arrière-plan.
- **PWA** : installable, fonctionne hors-ligne (service worker), icônes.
- **Wake Lock** (« Garder l'écran allumé ») + **MediaSession**.

Style : palette « Juicy sunset » (rose / corail / mangue) et police **Fredoka**,
toutes deux dans les variables CSS de `:root` ([`styles.css`](styles.css)).

Tout est en **HTML / CSS / JavaScript natif**, sans framework ni étape de
compilation. L'app tourne directement à partir des fichiers statiques.

---

## Développement local

Le service worker et la synthèse vocale exigent un **contexte sécurisé**.
`localhost` en est un, donc tout fonctionne en local (mais **pas** en ouvrant
le fichier en `file://`). Sers le dossier avec un petit serveur HTTP :

```bash
# au choix
python3 -m http.server 8000      # puis ouvre http://localhost:8000
npx serve                        # ou
npx http-server
```

Sur `http://localhost`, le service worker, la synthèse vocale, le Wake Lock et
l'installation fonctionnent tous en dev.

---

## Déploiement (GitHub Pages)

1. Pousse le dépôt sur GitHub.
2. **Settings → Pages → Deploy from branch** (par ex. `main` / racine).
3. L'app sera servie sous un sous-chemin, par ex.
   `https://<utilisateur>.github.io/allure/`.

Tous les chemins sont **relatifs** (`./asset`) et le manifeste / service worker
utilisent `start_url` et `scope` = `"./"`, donc l'app fonctionne telle quelle
sous ce sous-chemin. Le service worker est aussi enregistré avec un chemin
relatif (`./sw.js`).

Pour publier une mise à jour : incrémente `CACHE_VERSION` dans
[`sw.js`](sw.js) — les anciens caches sont nettoyés à l'activation.

---

## Audio & arrière-plan — limites honnêtes

L'app est **fiable au premier plan, écran allumé**. Dès que l'écran s'éteint ou
que l'app passe en arrière-plan, le navigateur suspend la boucle d'animation et
le contexte audio : le minuteur se fige et les annonces / la musique s'arrêtent
jusqu'au retour au premier plan (le décompte se recale alors tout seul grâce au
timing par horloge). **L'ambiance sonore générative est donc volontairement une
fonction de premier plan.**

Recommandation pratique : pour une séance importante, active « Garder l'écran
allumé » et garde l'app au premier plan. Le déverrouillage audio iOS se fait au
premier appui sur **Démarrer** (le contexte audio est repris), ce qui maximise
les chances que les annonces passent.

> **Chrome sur macOS** peut « bloquer » sa synthèse vocale : `speak()` met les
> annonces en file mais ne les démarre jamais (aucun son, `onstart` muet). Ce
> n'est pas un bug de l'app — Safari et Android fonctionnent. Remède :
> `chrome://restart` ou quitter complètement Chrome (⌘Q). En attendant, les bips
> et la vibration servent de repères.

---

## Structure des fichiers

```
index.html            structure (écran composeur + écran course, modales)
styles.css            palette Juicy sunset + Fredoka (variables CSS), mobile-first
app.js                logique (données, composeur, minuteur, voix, audio génératif)
manifest.webmanifest  manifeste PWA (start_url/scope = "./")
sw.js                 service worker (cache de la coquille, versionné)
icons/icon-192.png    icône PWA
icons/icon-512.png    icône PWA (et version maskable)
README.md             ce fichier
```

## Données (localStorage)

Tout est persisté localement sous la clé `allure.state.v1` :

- `categories` : `[{ id, label, color, song }]` — `song` = identifiant du morceau
  (`lever` | `asphalte` | `neon` | `recup` | `none`).
- `sequence` : `[{ categoryId, durationSeconds }]`
- `presets` : `[{ id, name, segments }]`
- `settings` : `{ loop, keepScreenAwake, beeps, voiceURI, soundscape,
  cadenceBpm, songBpm }`
  - `soundscape` : `none` | `music` | `cadence` | `both`
  - `cadenceBpm` : cadence du métronome (100–180 pas/min)
  - `songBpm` : tempo par morceau, ex. `{ lever: 124, asphalte: 144, … }` (80–180)

L'état est validé au chargement et réparé / migré s'il est vide, corrompu ou
issu d'une version antérieure (les champs manquants reçoivent des valeurs par
défaut).

## Musique générative

Les morceaux sont définis dans la constante `SONGS` en haut de
[`app.js`](app.js) : chacun est une **progression d'accords + un arrangement**
(motif de stabs, basse, arpège, percussions, forme d'onde, BPM par défaut). Le
moteur les synthétise en direct via l'horloge Web Audio. Pour ajuster ou ajouter
un morceau, édite cette liste.

## Renommer l'app

Le nom « Allure » apparaît dans `app.js` (constante `APP_NAME`, en haut), dans
[`index.html`](index.html) (`<title>` et `<h1>`) et dans
[`manifest.webmanifest`](manifest.webmanifest) (`name` / `short_name`).

## Notes

- Code volontairement lisible et commenté.
- Palette et polices dans les variables CSS de `:root` ([`styles.css`](styles.css)).
- `prefers-reduced-motion` est respecté (animations et pétales désactivés) ;
  fort contraste pour la lecture en plein jour.
