# Forkline

Forkline is a lightweight Linux desktop client for Git repositories, including
private and self-hosted repositories. It uses the Git executable and credential
helpers already configured on the machine.

## Run

```bash
npm install
npm start
```

## Fonctionnalités principales

- Ouverture de dépôts locaux publics, privés ou auto-hébergés.
- Graphe, branches, remotes, tags, stashes et travail en cours.
- Indexation par fichier ou hunk, abandon de hunk et aperçu des diffs.
- Commit, amend, stash partiel, fetch, pull et push configurables.
- Merge, rebase interactif, cherry-pick, revert et reset.
- Recherche de commits, historique et blame de fichiers, comparaison de références.
- Résolution des conflits en trois volets avec poursuite ou abandon de l'opération Git.
- Git Flow, sous-modules, worktrees, profils Git, signatures et prise en charge conditionnelle de Git LFS.
- Export de patch, terminal intégré au dépôt et ouverture externe des fichiers.
- Rafraîchissement automatique centralisé lors des changements du dépôt.

La matrice détaillée des fonctions et des écarts assumés est disponible dans
[`docs/gitkraken-parity.md`](docs/gitkraken-parity.md).

Forkline ne collecte aucune donnée de compte et n'impose aucune restriction sur
l'hébergement ou la visibilité des dépôts. L'authentification reste gérée par Git,
SSH et les gestionnaires d'identifiants du système.
