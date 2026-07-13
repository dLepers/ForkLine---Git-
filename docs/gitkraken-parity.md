# Parité fonctionnelle locale avec GitKraken

Cette matrice décrit les comportements observés dans l'installation locale de GitKraken. Elle sert de référence fonctionnelle, sans reprendre son code propriétaire.

## Pris en charge

- Ouverture et restauration d'un dépôt local, y compris avant le premier commit.
- Graphe multi-branches compact avec réutilisation des lanes libérées, références locales/distantes, tags, HEAD, travail en cours et stash.
- Rafraîchissement centralisé du dépôt et diffusion de snapshots aux vues Electron.
- Indexation, désindexation, abandon et indexation par hunk, aperçu des diffs.
- Commit, modification du message du dernier commit et stash complet ou partiel.
- Apply, pop et suppression de stash, avec remontée des conflits.
- Création, checkout, renommage et suppression sûre d'une branche.
- Merge, rebase, cherry-pick, revert et reset soft/mixed/hard.
- Détection, poursuite et abandon des merge/rebase/cherry-pick/revert interrompus.
- Pull, push, fetch et publication d'une branche avec upstream.
- Ajout, renommage, fetch/prune et suppression d'un dépôt distant.
- Création et suppression de tags légers ou annotés.
- Comparaison d'une branche ou d'un commit avec la copie de travail.
- Recherche par message, auteur, e-mail ou SHA dans l'historique.
- Historique et blame d'un fichier, liste et diff des fichiers d'un commit.
- Comparaison entre deux branches/références.
- Comparaison de deux commits sélectionnés directement dans le graphe.
- Amend du dernier commit avec son contenu indexé et son message.
- Options de pull fast-forward/rebase/merge et push des tags/force-with-lease.
- Choix explicite du dépôt distant et de la branche pour pull et push.
- Rebase interactif avec réorganisation, reword, squash, fixup et suppression de commits.
- Ouverture, clonage et initialisation de dépôts.
- Ouverture d'un terminal dans le dépôt, du dossier du dépôt et des fichiers dans leur application système ou un éditeur externe configurable.
- Checkout d'une branche distante avec création automatique de sa branche locale suivie.
- Publication et suppression distante des tags.
- Résolution des conflits en trois volets avec sélection ours/theirs par bloc et édition du résultat.
- Affichage et configuration locale/globale de l'identité Git, profils persistants assignables par dépôt ou automatiquement par chemin et URL distante.
- Signature optionnelle des commits et remontée détaillée des erreurs des hooks Git.
- Export d’un ou plusieurs commits au format patch Git et application `git am --3way` depuis un fichier ou le presse-papiers, avec résolution des conflits.
- Historique Undo/Redo multi-actions pour commit, cherry-pick, revert, merge, pull, reset et changement de branche, avec sélection par clic droit et invalidation dès que le dépôt change.
- Initialisation, cycle feature/release/hotfix et démarrage support depuis une base explicite avec Git Flow.
- Liste, ajout, synchronisation, mise à jour et désinitialisation des sous-modules.
- Liste, création, ouverture, suppression et nettoyage des worktrees.
- Détection de Git LFS, suivi des motifs et pull/push LFS lorsque l'extension est installée.
- Recherche combinée avec texte, `author:`, `file:`, `after:`, `before:` et `branch:`.

## Dépendances externes

- Les fonctions LFS sont désactivées avec une explication lorsque `git-lfs` n'est pas installé.
- L'ouverture du terminal nécessite un terminal graphique disponible dans `$TERMINAL` ou parmi les terminaux Linux usuels.
- Les signatures dépendent de la configuration GPG/SSH de Git et de l'accès à la clé locale.
- Les hooks restent exécutés par Git ; Forkline affiche leur sortie mais ne les contourne pas.

## Hors périmètre de la parité locale

- Comptes GitKraken, Cloud Patches et espaces collaboratifs propriétaires.
- Intégrations hébergeur spécifiques pour pull requests, issues et CI.
- Contournement de licence ou réutilisation du code propriétaire de GitKraken.

## Critères de livraison

- Aucune action visible ne doit être un bouton factice : elle fonctionne ou elle est désactivée avec une explication.
- Toute mutation passe par `RepositoryWatcher.mutate()` et publie un snapshot unique.
- Toute opération destructive demande une confirmation explicite.
- Les conflits restent dans un état Git récupérable avec des actions Continuer et Abandonner.
- Chaque commande ajoutée au service Git possède au moins un test dans un dépôt temporaire.
