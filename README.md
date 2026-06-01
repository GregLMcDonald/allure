# Allure

**Allure** est une petite application web installable (PWA) d'entraînement par
intervalles pour la course à pied. Tu composes une suite de segments
chronométrés (chacun = une catégorie + une durée), puis un minuteur fait le
décompte et **annonce chaque segment à voix haute** (synthèse vocale du
navigateur). Toute l'interface est en français.

> Style inspiré de l'esprit de **Les Roses** (lesroses.ca) : chaleureux,
> élégant, encourageant — la progression plutôt que la compétition.

---

## Fonctionnalités

- **Composeur** : catégories tappables (par défaut `marche`, `v1`, `v2`),
  ajout de segments avec durée en `mm:ss`, réorganisation, édition, suppression.
- **Catégories éditables** : ajouter, renommer, recolorer, supprimer.
- **Séquences enregistrées** (presets) + **export / import JSON**.
- **Boucle** de la séquence entière.
- **Écran de course** : grand décompte central, anneau de progression
  circulaire (SVG), catégorie en cours + « Suivant : … », Pause/Reprendre,
  Suivant, Précédent, Arrêter.
- **Annonces vocales en français** au début de chaque segment
  (« Marche, deux minutes »), avec choix de la voix.
- **Vibration** à chaque changement de segment (repli silencieux).
- **Bips 3-2-1** optionnels avant chaque transition.
- **Minuteur basé sur l'horloge** (timestamps) : il se corrige tout seul après
  une mise en arrière-plan.
- **PWA** : installable, fonctionne hors-ligne (service worker), icônes.
- **Wake Lock** (« Garder l'écran allumé ») + **MediaSession** + audio quasi
  silencieux pour la lecture en arrière-plan (meilleur effort, voir limites).

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

## Lecture en arrière-plan et « ducking » — limites honnêtes

Tu veux verrouiller le téléphone, écouter ta musique dans une autre app, et
recevoir quand même les annonces vocales (idéalement en baissant la musique).
**La plateforme web ne le permet que partiellement**, et le comportement
diffère entre iOS Safari et Android Chrome. Voici ce qui est implémenté et ce
qu'il faut en attendre.

**Ce qui est fait (meilleur effort) :**

- **Timing basé sur l'horloge** : chaque segment a une heure de fin absolue ;
  le temps restant est recalculé à partir de `Date.now()` à chaque image, donc
  le décompte se corrige après tout ralentissement en arrière-plan.
- **Audio quasi silencieux en boucle** pendant une course, pour réduire la
  probabilité que l'onglet soit suspendu et pour ancrer une session média.
- **MediaSession API** : titre = segment en cours, et les boutons
  lecture / pause / piste suivante du système sont reliés aux contrôles de
  l'app.
- **Wake Lock** (« Garder l'écran allumé »), ré-acquis au retour sur la page
  (`visibilitychange`) — la solution fiable pour garder une course active
  écran allumé, courant pour les apps de course.

**Limites réelles :**

- **Fiable au premier plan, écran allumé.** Dès que l'écran s'éteint ou que
  l'app passe en arrière-plan, le maintien du minuteur et le déclenchement des
  annonces dépendent du système et ne sont **pas garantis**.
- **iOS / Safari** suspend agressivement les onglets en arrière-plan et tend à
  **mettre en pause** la musique d'autres apps quand la synthèse vocale parle
  (plutôt que de la baisser).
- **Android / Chrome** tolère mieux l'arrière-plan et tend plutôt à **baisser
  (duck)** la musique pendant l'annonce.
- **Une page web ne peut pas régler directement le volume d'une autre app.**
  Le choix « baisser » vs « mettre en pause » de la musique de fond est décidé
  par le modèle de *focus audio* du système quand notre audio / voix se
  déclenche — pas par l'app. Il n'existe pas d'API web fiable pour le forcer.

**Recommandation pratique :** pour une séance importante, active
« Garder l'écran allumé » et garde l'app au premier plan. Le déverrouillage
audio iOS se fait au premier appui sur **Démarrer** (un contexte audio est
repris et une annonce d'amorçage muette est jouée), ce qui maximise les chances
que les annonces suivantes passent.

---

## Structure des fichiers

```
index.html            structure (écran composeur + écran course, modales)
styles.css            thème Les Roses (variables CSS), mise en page mobile-first
app.js                logique (données, composeur, minuteur, voix, arrière-plan)
manifest.webmanifest  manifeste PWA (start_url/scope = "./")
sw.js                 service worker (cache de la coquille, versionné)
icons/icon-192.png    icône PWA
icons/icon-512.png    icône PWA (et version maskable)
README.md             ce fichier
```

## Données (localStorage)

Tout est persisté localement sous la clé `allure.state.v1` :

- `categories` : `[{ id, label, color }]`
- `sequence` : `[{ categoryId, durationSeconds }]`
- `presets` : `[{ id, name, segments }]`
- `settings` : `{ loop, keepScreenAwake, beeps, voiceURI }`

L'état est validé au chargement et réparé / migré s'il est vide ou corrompu.

## Renommer l'app

Le nom « Allure » apparaît dans `app.js` (constante `APP_NAME`, en haut), dans
[`index.html`](index.html) (`<title>` et `<h1>`) et dans
[`manifest.webmanifest`](manifest.webmanifest) (`name` / `short_name`).

## Notes

- Code volontairement lisible et commenté.
- Palette et polices dans les variables CSS de `:root` ([`styles.css`](styles.css)).
- `prefers-reduced-motion` est respecté ; fort contraste pour la lecture en
  plein jour.
