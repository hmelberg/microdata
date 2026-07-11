# sklearn_brython (Brython lib-utvidelse stadie 6c) — plan

**Goal:** `from sklearn.cluster import KMeans` osv. virker i Brython-modus — sklearn-subsett
i ren Python, diff-testet mot scikit-learn 1.9.0.

**Beslutning vs veikartet:** veikartet foreslo ml.js-wrapper; vi velger REN PYTHON som i
stadie 3–5: full diff-testbarhet i CPython, ingen JS-interop-feller (jf. json-float-tainten
fra stadie 6b), og numerikken er triviell på undervisningsskala.

**Arkitektur:** én fil `brython/sklearn_brython.py`, montert fra seksjonsfiler
(`_skl_helpers.py` + `_skl_part_linear.py` + `_skl_part_cluster.py` + `_skl_part_core.py`
+ namespace-hale). Flat modul + `_NS`-namespace-objekter (`linear_model`, `cluster`, …)
slik at både `from sklearn.cluster import KMeans` og `from sklearn import cluster` virker
via de dottede aliasene i LIB_REGISTRY (mekanisme fra stadie 2/4).

**Omfang:**
- linear_model: `LinearRegression`, `LogisticRegression` (binær, L2/C som sklearn)
- cluster: `KMeans` (k-means++, Lloyd) — decomposition: `PCA` (Jacobi-egendekomponering)
- model_selection: `train_test_split` — preprocessing: `StandardScaler`
- neighbors: `KNeighborsClassifier` — metrics: `accuracy_score`, `confusion_matrix`,
  `mean_squared_error`, `r2_score`
- predict/transform returnerer numpy_brython-arrays; deps: `['numpy_brython']`
- Utenfor omfang → norsk NotImplementedError/ValueError (stratify, multiklasse-logit, …)

**Orkestrering (subagenter, maks 10):** 3 parallelle implementasjonsagenter (linear /
cluster+pca / core) som skriver hver sin seksjonsfil + testfiler og selv-tester i
scratch-montering; montering, registry, eksempel og browser-verifisering inline; 2
parallelle port-agenter (safestat master, openstat main) via worktree-oppskriften fra
stadie 6b. Kjente delta mot sklearn dokumenteres i modulens docstring: train_test_split
gir ikke samme permutasjon som sklearn ved samme seed; singulær X gir norsk feil i stedet
for minimum-norm-løsning.

**Deploy:** sw.js CACHE-bump (microdata v15, safestat v14, openstat v15); eksempel bry19
(microdata) / bry22 (safestat+openstat); knapp i index.html; safestat/openstat portes via
midlertidig worktree (dash-v2-forbedringer er utsjekket av annen økt).
