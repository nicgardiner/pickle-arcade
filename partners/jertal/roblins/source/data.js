// Roblins data tables. Plain data only: no logic, no rendering.
// Loaded as a classic script in the browser and with require() in Node.
(function (root) {
  'use strict';
  var GOB = root.GOB = root.GOB || {};

  GOB.Data = {
    cellSize: 2, // meters per grid cell

    player: {
      radius: 0.28,
      height: 1.2,          // a standing goblin, meters
      crouchHeight: 0.75,
      eyeOffset: 0.12,      // eyes sit this far below the top of the head
      walkSpeed: 2.6,
      sprintSpeed: 4.6,
      crouchSpeed: 1.3,
      accel: 14,
      airControl: 0.3,
      stepUp: 0.5,          // tallest ledge you can walk up without jumping
      jumpSpeed: 3.8,       // a short hop, about 0.6 m
      gravity: 12,
      safeFall: 2.5,        // meters you can drop without getting hurt
      fallDamagePerMeter: 25,
      maxHp: 100,
      staminaDrain: 0.22,   // per second of sprinting
      staminaRegen: 0.16,
      staminaRegenDelay: 1.0,
      staminaRecover: 0.3,  // after running dry, sprint again above this
      strideWalk: 1.1,      // meters per footstep
      strideSprint: 1.6,
      strideCrouch: 0.8
    },

    lantern: {
      burnSeconds: 480,     // a full lantern burns for 8 minutes of on-time
      relightCost: 0.05,    // lighting it again spills a splash of oil (a bat swarm snuffing you costs this)
      lowOil: 0.2,
      refillRate: 0.12,     // per second while standing at the Gutbucket\'s oil barrel
      refillRadius: 1.5,
      range: 11,
      lowRange: 5,
      intensity: 1.5,
      color: 0xffb35c
    },

    // Loudness of each action. Heard radius = loudness * surface.loud * baseRadius.
    noise: { crouch: 0.3, walk: 0.6, sprint: 1.0, land: 0.9, chest: 0.5, baseRadius: 14,
      voice: { threshold: 0.12, radius: 16, every: 0.3 }, // microphone loudness 0-1 -> heard radius
      thud: { light: 0.35, medium: 0.6, heavy: 0.9, twoHanded: 1.0 } },

    surfaces: {
      grass:  { loud: 0.7,  color: 0x44533a },
      path:   { loud: 0.85, color: 0x584a37 },
      stone:  { loud: 1.0,  color: 0x696b62 },
      dirt:   { loud: 0.8,  color: 0x4c3f31 },
      gravel: { loud: 1.3,  color: 0x6f6b5f }, // bone-strewn gravel in burial halls
      sand:   { loud: 0.55, color: 0x9a8058 }, // soft desert sand, drifts in the pyramid\'s corridors
      sandstone: { loud: 1.0, color: 0x8e7650 },
      wood:   { loud: 1.1,  color: 0x5a4028 }, // the Gutbucket\'s deck
      basalt: { loud: 1.05, color: 0x3e3d42 }, // dwarven flagstones
      scree:  { loud: 1.2,  color: 0x55534f }, // loose rock on the mountainside
      planks: { loud: 1.3,  color: 0x6a5238 }, // rope bridges: they creak
      deck:   { loud: 1.15, color: 0x5e4a34 }, // a wreck's warped boards
      water:  { loud: 1.25, color: 0x2a4a50 }, // wading: every step splashes
      loam:   { loud: 0.6,  color: 0x3a3430 }, // soft, spore-rich cave floor
      tatami: { loud: 0.45, color: 0x8a8a52 }, // woven mats: quiet
      nightingale: { loud: 1.7, color: 0x6a4a2e, crouchSilent: true } // boards that sing when walked on, unless you creep
    },

    // One night, dusk to dawn. Hours run 18 (6 p.m.) to 30 (6 a.m. next day).
    night: {
      startHour: 18, endHour: 30, realSeconds: 780,
      bellHour: 29,          // Mortimer\'s warning bell at 5 a.m.
      landingSeconds: 4, liftOffSeconds: 4.5, liftHeight: 30,
      helmHoldSeconds: 1.2,  // hold E this long at the helm to leave early
      clockVisibleInside: false
    },

    // Carrying. Weight is in "stones" (roughly kg); load slows you and makes you louder.
    inventory: {
      slots: 4, reach: 2.2,
      weights: { light: 1, medium: 3, heavy: 7, twoHanded: 14 },
      speedPerWeight: 0.02, minSpeedFactor: 0.55,
      drainPerWeight: 0.03, noisePerWeight: 0.025,
      throwSpeed: { light: 8, medium: 6.5, heavy: 4.5, twoHanded: 3.5 }
    },

    // The crew\'s airship. Sizes in meters; it lands with its long side facing the tomb.
    gutbucket: { length: 9.5, width: 4, deck: 0.45, gangway: 1.4 },

    // Loot. value: gold range rolled at spawn. depth: 0-1, how deep in the tomb it
    // starts to appear. rarity: relative spawn weight (0 = placed by hand only).
    items: {
      bronze_bracelet: { name: 'Bronze bracelet', tombs: 'any', value: [10, 25], weight: 'light', rarity: 10, depth: 0, mesh: 'bracelet', material: 'bronze', tags: ['shiny', 'pretty'] },
      silver_goblet:   { name: 'Silver goblet', tombs: 'any', value: [30, 60], weight: 'light', rarity: 6, depth: 0.2, mesh: 'goblet', material: 'silver', tags: ['shiny'] },
      bone_comb:       { name: 'Bone comb', tombs: 'barrow', value: [5, 15], weight: 'light', rarity: 9, depth: 0, mesh: 'comb', material: 'bone', tags: ['old', 'pretty'] },
      amber_brooch:    { name: 'Amber brooch', tombs: 'barrow', value: [20, 40], weight: 'light', rarity: 7, depth: 0.1, mesh: 'brooch', material: 'amber', tags: ['pretty'] },
      bronze_torc:     { name: 'Bronze torc', tombs: 'barrow', value: [40, 70], weight: 'medium', rarity: 5, depth: 0.3, mesh: 'torc', material: 'bronze', tags: ['shiny', 'pretty'] },
      iron_helm:       { name: 'Iron helm', tombs: 'barrow', value: [35, 60], weight: 'heavy', rarity: 4, depth: 0.3, mesh: 'helm', material: 'iron', tags: ['big'] },
      rune_stone:      { name: 'Rune stone', tombs: 'barrow', value: [40, 80], weight: 'heavy', rarity: 4, depth: 0.4, mesh: 'runestone', material: 'stone', tags: ['big', 'old'] },
      gold_arm_ring:   { name: 'Gold arm-ring', tombs: 'barrow', value: [70, 110], weight: 'light', rarity: 2, depth: 0.6, mesh: 'armring', material: 'gold', tags: ['shiny', 'pretty'] },
      drinking_horn:   { name: 'Silver-rimmed drinking horn', tombs: 'barrow', value: [45, 75], weight: 'light', rarity: 4, depth: 0.3, mesh: 'horn', material: 'bone', tags: ['old', 'shiny'] },
      hack_silver:     { name: 'Hack-silver', tombs: 'barrow', value: [12, 28], weight: 'light', rarity: 8, depth: 0, mesh: 'hacksilver', material: 'silver', tags: ['shiny'] },
      bone_dice:       { name: 'Carved bone dice', tombs: 'barrow', value: [8, 18], weight: 'light', rarity: 7, depth: 0, mesh: 'dice', material: 'bone', tags: ['old'] },
      round_shield:    { size: 0.6, name: 'Round shield', tombs: 'barrow', value: [45, 75], weight: 'heavy', rarity: 3, depth: 0.3, mesh: 'shield', material: 'wood', tags: ['big', 'old'] },
      cauldron:        { size: 0.6, name: 'Chieftain\'s cauldron', tombs: 'barrow', value: [100, 150], weight: 'twoHanded', rarity: 2.5, depth: 0.45, mesh: 'cauldron', material: 'bronze', tags: ['big', 'old'] },
      hoard_urn:       { size: 0.55, name: 'Hoard urn', tombs: 'barrow', value: [110, 170], weight: 'twoHanded', rarity: 0, depth: 1, mesh: 'urn', material: 'clay', tags: ['big', 'old'] },

      // Mortimer\'s tools. They sit in your slots like loot, but Craig pays nothing for them.
      // use: what left click does while the tool is in hand.
      torch:        { name: 'Torch', tool: true, price: 5, value: [0, 0], weight: 'light', rarity: 0, mesh: 'torch', material: 'wood',
                      use: 'none', burnSeconds: 150, light: { color: 0xff9a40, intensity: 2.2, range: 14 } },
      club:         { name: 'Club', tool: true, price: 30, value: [0, 0], weight: 'medium', rarity: 0, mesh: 'club', material: 'wood',
                      use: 'swing', swingSeconds: 0.45, noise: 0.45 },
      flash_powder: { name: 'Flash-powder', tool: true, price: 20, value: [0, 0], weight: 'light', rarity: 0, mesh: 'pouch', material: 'cloth',
                      use: 'flash', noise: 1.0, flashSeconds: 3 },
      oil_flask:    { name: 'Oil flask', tool: true, price: 10, value: [0, 0], weight: 'light', rarity: 0, mesh: 'flask', material: 'clay',
                      use: 'refill' },
      spade:        { name: 'Digging spade', tool: true, price: 35, value: [0, 0], weight: 'medium', rarity: 0, mesh: 'spade', material: 'iron',
                      use: 'dig' },
      // Hold T with it in hand: your voice comes out of every other goblin's shell, at any distance.
      whisper_shell: { name: 'Whisper shell', tool: true, price: 15, value: [0, 0], weight: 'light', rarity: 0, mesh: 'shell', material: 'pearl',
                      use: 'shell', shell: true },
      // Left click, once: Mortimer yanks you (and whatever you carry) back onto the deck. Then it's spent.
      recall_totem: { name: 'Recall totem', tool: true, price: 60, value: [0, 0], weight: 'light', rarity: 0, mesh: 'totem', material: 'wood',
                      use: 'recall' },

      // Pharaoh\'s Tomb. cursed: its carrier is marked, and the Mummy always knows where it is.
      ushabti:          { name: 'Ushabti figurine', tombs: 'pharaoh', value: [15, 35], weight: 'light', rarity: 9, depth: 0, mesh: 'ushabti', material: 'faience', tags: ['old', 'pretty'] },
      faience_beads:    { name: 'Faience beads', tombs: 'pharaoh', value: [10, 25], weight: 'light', rarity: 9, depth: 0, mesh: 'beads', material: 'faience', tags: ['pretty'] },
      papyrus_scroll:   { name: 'Papyrus scroll', tombs: 'pharaoh', value: [20, 40], weight: 'light', rarity: 7, depth: 0.1, mesh: 'scroll', material: 'papyrus', tags: ['old'] },
      alabaster_vase:   { name: 'Alabaster vase', tombs: 'pharaoh', value: [40, 70], weight: 'medium', rarity: 5, depth: 0.2, mesh: 'vase', material: 'alabaster', tags: ['pretty'] },
      gilded_ankh:      { name: 'Gilded ankh', tombs: 'pharaoh', value: [60, 100], weight: 'medium', rarity: 4, depth: 0.3, mesh: 'ankh', material: 'gold', tags: ['shiny'] },
      canopic_jar:      { name: 'Canopic jar', tombs: 'pharaoh', value: [70, 120], weight: 'medium', rarity: 5, depth: 0.2, mesh: 'canopic', material: 'alabaster', tags: ['old'], cursed: true },
      scarab_amulet:    { name: 'Scarab amulet', tombs: 'pharaoh', value: [50, 90], weight: 'light', rarity: 5, depth: 0.2, mesh: 'scarab', material: 'faience', tags: ['pretty', 'shiny'], cursed: true },
      golden_death_mask: { name: 'Golden death mask', tombs: 'pharaoh', value: [180, 260], weight: 'medium', rarity: 0, depth: 1, mesh: 'deathmask', material: 'gold', tags: ['shiny', 'pretty'], cursed: true },
      bastet_cat:       { name: 'Bastet cat statuette', tombs: 'pharaoh', value: [55, 95], weight: 'medium', rarity: 4, depth: 0.3, mesh: 'bastet', material: 'granite', tags: ['old', 'pretty'] },
      kohl_pot:         { name: 'Kohl pot', tombs: 'pharaoh', value: [12, 25], weight: 'light', rarity: 8, depth: 0, mesh: 'kohlpot', material: 'alabaster', tags: ['pretty'] },
      horus_eye:        { name: 'Eye of Horus amulet', tombs: 'pharaoh', value: [30, 55], weight: 'light', rarity: 5, depth: 0.15, mesh: 'horuseye', material: 'gold', tags: ['shiny', 'pretty'] },
      painted_stele:    { size: 0.55, name: 'Painted stele', tombs: 'pharaoh', value: [50, 85], weight: 'heavy', rarity: 3, depth: 0.3, mesh: 'stele', material: 'granite', tags: ['big', 'old'] },
      anubis_statue:    { size: 0.9, name: 'Anubis statue', tombs: 'pharaoh', value: [110, 170], weight: 'twoHanded', rarity: 2.5, depth: 0.45, mesh: 'anubis', material: 'granite', tags: ['big', 'old'], cursed: true },
      sarcophagus_lid:  { size: 2.0, name: 'Sarcophagus lid', tombs: 'pharaoh', value: [350, 500], weight: 'twoHanded', rarity: 0, depth: 1, mesh: 'lid', material: 'granite', tags: ['big', 'old'], wakes: 'pharaoh' },

      // Dwarf Ossuary. slow: an extra speed factor while carried.
      ancestor_skull:  { name: 'Ancestor skull', tombs: 'ossuary', value: [8, 20], weight: 'light', rarity: 9, depth: 0, mesh: 'skull', material: 'bone', tags: ['old'] },
      beard_ring:      { name: 'Beard-ring', tombs: 'ossuary', value: [15, 30], weight: 'light', rarity: 10, depth: 0, mesh: 'beardring', material: 'brass', tags: ['shiny', 'pretty'] },
      jewelled_tankard: { name: 'Jewelled tankard', tombs: 'ossuary', value: [30, 55], weight: 'medium', rarity: 7, depth: 0.1, mesh: 'tankard', material: 'pewter', tags: ['shiny'] },
      raw_gems:        { name: 'Raw gems', tombs: 'ossuary', value: [35, 65], weight: 'light', rarity: 6, depth: 0.2, mesh: 'gems', material: 'gem', tags: ['shiny', 'pretty'] },
      rune_axe:        { size: 0.6, name: 'Rune axe', tombs: 'ossuary', value: [50, 85], weight: 'medium', rarity: 4, depth: 0.3, mesh: 'axe', material: 'iron', tags: ['old', 'big'] },
      gold_ingot:      { name: 'Gold ingot', tombs: 'ossuary', value: [70, 110], weight: 'heavy', rarity: 3, depth: 0.45, mesh: 'ingot', material: 'gold', tags: ['shiny'] },
      miners_lamp:     { name: 'Brass miner\'s lamp', tombs: 'ossuary', value: [30, 55], weight: 'medium', rarity: 6, depth: 0.15, mesh: 'minerlamp', material: 'brass', tags: ['shiny', 'old'] },
      signet_ring:     { name: 'Dwarven signet ring', tombs: 'ossuary', value: [25, 45], weight: 'light', rarity: 6, depth: 0.1, mesh: 'signet', material: 'gold', tags: ['shiny', 'pretty'] },
      bone_pipe:       { name: 'Carved bone pipe', tombs: 'ossuary', value: [10, 22], weight: 'light', rarity: 8, depth: 0, mesh: 'pipe', material: 'bone', tags: ['old'] },
      war_hammer:      { size: 0.65, name: 'Dwarven war-hammer', tombs: 'ossuary', value: [55, 90], weight: 'medium', rarity: 3, depth: 0.35, mesh: 'hammer', material: 'iron', tags: ['big', 'old'] },
      ancestor_bust:   { size: 0.5, name: 'Ancestor bust', tombs: 'ossuary', value: [60, 95], weight: 'heavy', rarity: 3, depth: 0.3, mesh: 'bust', material: 'stone', tags: ['big', 'old'] },
      rune_keg:        { size: 0.6, name: 'Rune-sealed keg', tombs: 'ossuary', value: [100, 150], weight: 'twoHanded', rarity: 2.5, depth: 0.4, mesh: 'keg', material: 'wood', tags: ['big', 'old'] },
      deep_crown:      { name: 'Deep King\'s crown', tombs: 'ossuary', value: [160, 240], weight: 'light', rarity: 0, depth: 1, mesh: 'crown', material: 'mithril', tags: ['shiny', 'pretty', 'old'] },
      dwarven_anvil:   { size: 0.8, name: 'Dwarven anvil', tombs: 'ossuary', value: [90, 140], weight: 'twoHanded', rarity: 0, depth: 1, mesh: 'anvil', material: 'iron', tags: ['big', 'old'], slow: 0.7 },

      // Sunken Galleon
      doubloons:       { name: 'Pouch of doubloons', tombs: 'galleon', value: [15, 30], weight: 'light', rarity: 11, depth: 0, mesh: 'doubloons', material: 'gold', tags: ['shiny'] },
      rum_bottle:      { name: 'Bottle of old rum', tombs: 'galleon', value: [10, 22], weight: 'light', rarity: 8, depth: 0, mesh: 'bottle', material: 'glass', tags: ['old'] },
      pearl_necklace:  { name: 'Pearl necklace', tombs: 'galleon', value: [30, 55], weight: 'light', rarity: 6, depth: 0.1, mesh: 'pearls', material: 'pearl', tags: ['pretty'] },
      brass_spyglass:  { name: 'Brass spyglass', tombs: 'galleon', value: [35, 60], weight: 'light', rarity: 5, depth: 0.2, mesh: 'spyglass', material: 'brass', tags: ['shiny', 'old'] },
      captains_sword:  { size: 0.8, name: 'Captain\'s sword', tombs: 'galleon', value: [60, 100], weight: 'medium', rarity: 3, depth: 0.4, mesh: 'sword', material: 'silver', tags: ['shiny', 'big'] },
      ships_bell:      { name: 'Ship\'s bell', tombs: 'galleon', value: [50, 85], weight: 'heavy', rarity: 3, depth: 0.3, mesh: 'bell', material: 'brass', tags: ['big', 'old'] },
      ship_in_bottle:  { name: 'Ship in a bottle', tombs: 'galleon', value: [40, 70], weight: 'light', rarity: 4, depth: 0.25, mesh: 'bottleship', material: 'wood', tags: ['pretty', 'old'] },
      scrimshaw:       { name: 'Scrimshaw tooth', tombs: 'galleon', value: [15, 30], weight: 'light', rarity: 7, depth: 0, mesh: 'scrimshaw', material: 'bone', tags: ['old', 'pretty'] },
      pocket_watch:    { name: 'Captain\'s pocket watch', tombs: 'galleon', value: [30, 55], weight: 'light', rarity: 5, depth: 0.15, mesh: 'watch', material: 'gold', tags: ['shiny', 'pretty'] },
      ships_wheel:     { size: 0.7, name: 'Ship\'s wheel', tombs: 'galleon', value: [45, 80], weight: 'heavy', rarity: 3, depth: 0.3, mesh: 'wheel', material: 'wood', tags: ['big', 'old'] },
      figurehead:      { size: 1.0, name: 'Mermaid figurehead', tombs: 'galleon', value: [100, 160], weight: 'twoHanded', rarity: 2.5, depth: 0.4, mesh: 'figurehead', material: 'wood', tags: ['big', 'pretty'] },
      jewelled_compass: { name: 'Jewelled compass', tombs: 'galleon', value: [120, 180], weight: 'light', rarity: 0, depth: 1, mesh: 'compass', material: 'gold', tags: ['shiny', 'pretty'] },
      // Yomi Shrine
      koban:           { name: 'Gold koban', tombs: 'yomi', value: [18, 32], weight: 'light', rarity: 11, depth: 0, mesh: 'koban', material: 'gold', tags: ['shiny'] },
      sake_jug:        { name: 'Sake jug', tombs: 'yomi', value: [15, 30], weight: 'medium', rarity: 8, depth: 0, mesh: 'sakejug', material: 'clay', tags: ['old'] },
      jade_netsuke:    { name: 'Jade netsuke', tombs: 'yomi', value: [35, 60], weight: 'light', rarity: 6, depth: 0.1, mesh: 'netsuke', material: 'jade', tags: ['pretty'] },
      kitsune_mask:    { name: 'Kitsune mask', tombs: 'yomi', value: [30, 55], weight: 'light', rarity: 6, depth: 0.15, mesh: 'kitsune', material: 'lacquer', tags: ['pretty', 'old'] },
      lacquer_box:     { name: 'Lacquer box', tombs: 'yomi', value: [45, 75], weight: 'medium', rarity: 4, depth: 0.25, mesh: 'lacquerbox', material: 'lacquer', tags: ['pretty', 'shiny'] },
      katana:          { size: 0.95, name: 'Katana', tombs: 'yomi', value: [80, 120], weight: 'medium', rarity: 2, depth: 0.5, mesh: 'katana', material: 'silver', tags: ['shiny', 'big'] },
      omamori:         { name: 'Omamori charm', tombs: 'yomi', value: [10, 22], weight: 'light', rarity: 8, depth: 0, mesh: 'omamori', material: 'cloth', tags: ['pretty'] },
      tessen_fan:      { name: 'Iron war-fan', tombs: 'yomi', value: [30, 55], weight: 'light', rarity: 5, depth: 0.15, mesh: 'fan', material: 'lacquer', tags: ['pretty', 'old'] },
      temple_bell:     { size: 0.5, name: 'Bronze temple bell', tombs: 'yomi', value: [50, 85], weight: 'heavy', rarity: 3, depth: 0.3, mesh: 'templebell', material: 'bronze', tags: ['big', 'old'] },
      samurai_armour:  { size: 0.9, name: 'Samurai armour', tombs: 'yomi', value: [110, 170], weight: 'twoHanded', rarity: 2.5, depth: 0.45, mesh: 'armour', material: 'lacquer', tags: ['big', 'shiny'] },
      bronze_mirror:   { name: 'Bronze mirror', tombs: 'yomi', value: [170, 250], weight: 'light', rarity: 0, depth: 1, mesh: 'mirror', material: 'bronze', tags: ['shiny', 'old'] },
      mikoshi:         { size: 1.3, name: 'Golden mikoshi', tombs: 'yomi', value: [280, 400], weight: 'twoHanded', rarity: 0, depth: 1, mesh: 'mikoshi', material: 'gold', tags: ['big', 'shiny'] },

      // Mushroom Warren
      truffle:         { name: 'Rare truffle', tombs: 'mushroom', value: [12, 28], weight: 'light', rarity: 11, depth: 0, mesh: 'truffle', material: 'fungus', tags: ['old'] },
      glow_spores:     { name: 'Jar of glow-spores', tombs: 'mushroom', value: [20, 40], weight: 'light', rarity: 7, depth: 0.1, mesh: 'sporejar', material: 'glass', tags: ['pretty', 'shiny'] },
      crystal_geode:   { name: 'Crystal geode', tombs: 'mushroom', value: [45, 80], weight: 'medium', rarity: 5, depth: 0.2, mesh: 'geode', material: 'gem', tags: ['pretty', 'shiny'] },
      old_backpack:    { name: 'Petrified backpack', tombs: 'mushroom', value: [55, 95], weight: 'heavy', rarity: 3, depth: 0.35, mesh: 'backpack', material: 'stone', tags: ['old', 'big'] },
      fairy_ring:      { name: 'Fairy-ring stone', tombs: 'mushroom', value: [30, 55], weight: 'medium', rarity: 5, depth: 0.15, mesh: 'ringstone', material: 'stone', tags: ['old', 'pretty'] },
      moss_idol:       { name: 'Moss-grown idol', tombs: 'mushroom', value: [40, 70], weight: 'medium', rarity: 5, depth: 0.2, mesh: 'idol', material: 'stone', tags: ['old', 'pretty'] },
      amber_moth:      { name: 'Glow-moth in amber', tombs: 'mushroom', value: [20, 40], weight: 'light', rarity: 6, depth: 0.05, mesh: 'ambermoth', material: 'amber', tags: ['pretty', 'old'] },
      gnome_hat:       { name: 'Lost gnome hat', tombs: 'mushroom', value: [8, 18], weight: 'light', rarity: 8, depth: 0, mesh: 'gnomehat', material: 'cloth', tags: ['pretty'] },
      fossil_shell:    { size: 0.5, name: 'Giant fossil shell', tombs: 'mushroom', value: [50, 85], weight: 'heavy', rarity: 3, depth: 0.3, mesh: 'fossil', material: 'stone', tags: ['big', 'old'] },
      stone_gnome:     { size: 0.8, name: 'Petrified gnome', tombs: 'mushroom', value: [100, 160], weight: 'twoHanded', rarity: 2.5, depth: 0.4, mesh: 'stonegnome', material: 'stone', tags: ['big', 'old'] },
      spore_heart:     { name: 'Spore Heart', tombs: 'mushroom', value: [150, 230], weight: 'light', rarity: 0, depth: 1, mesh: 'sporeheart', material: 'fungus', tags: ['pretty', 'shiny', 'old'] },
      mother_cap:      { size: 0.85, name: 'Mother Cap', tombs: 'mushroom', value: [220, 330], weight: 'twoHanded', rarity: 0, depth: 1, mesh: 'mothercap', material: 'fungus', tags: ['big', 'pretty'] },
      treasure_chest:  { size: 0.75, name: 'Treasure chest', tombs: 'galleon', value: [260, 380], weight: 'twoHanded', rarity: 0, depth: 1, mesh: 'treasurechest', material: 'wood', tags: ['big', 'shiny'] },

      // Terracotta Mausoleum
      jade_cicada:     { name: 'Jade cicada', tombs: 'terracotta', value: [15, 30], weight: 'light', rarity: 9, depth: 0, mesh: 'cicada', material: 'jade', tags: ['pretty', 'old'] },
      cowrie_string:   { name: 'String of cowrie money', tombs: 'terracotta', value: [10, 22], weight: 'light', rarity: 10, depth: 0, mesh: 'beads', material: 'pearl', tags: ['pretty'] },
      jade_bi:         { name: 'Jade bi disc', tombs: 'terracotta', value: [25, 45], weight: 'light', rarity: 7, depth: 0.1, mesh: 'bidisc', material: 'jade', tags: ['pretty', 'old'] },
      silk_scroll:     { name: 'Silk scroll', tombs: 'terracotta', value: [20, 40], weight: 'light', rarity: 6, depth: 0.15, mesh: 'scroll', material: 'cloth', tags: ['old'] },
      lacquered_box:   { name: 'Lacquered box', tombs: 'terracotta', value: [35, 60], weight: 'medium', rarity: 5, depth: 0.2, mesh: 'tclacquerbox', material: 'lacquer', tags: ['pretty', 'shiny'] },
      bronze_jian:     { name: 'Bronze sword', tombs: 'terracotta', value: [45, 75], weight: 'medium', rarity: 5, depth: 0.25, mesh: 'jian', material: 'bronze', tags: ['shiny', 'old'] },
      bronze_ding:     { size: 0.5, name: 'Bronze cauldron', tombs: 'terracotta', value: [60, 95], weight: 'heavy', rarity: 3, depth: 0.35, mesh: 'ding', material: 'bronze', tags: ['big', 'old'] },
      terracotta_horse: { size: 1.0, name: 'Terracotta horse', tombs: 'terracotta', value: [110, 170], weight: 'twoHanded', rarity: 2.5, depth: 0.45, mesh: 'tchorse', material: 'clay', tags: ['big', 'old'] },
      gold_seal:       { name: 'Emperor\'s gold seal', tombs: 'terracotta', value: [160, 240], weight: 'light', rarity: 0, depth: 1, mesh: 'seal', material: 'gold', tags: ['shiny', 'old'] },
      jade_suit:       { size: 1.2, name: 'Jade burial suit', tombs: 'terracotta', value: [270, 390], weight: 'twoHanded', rarity: 0, depth: 1, mesh: 'jadesuit', material: 'jade', tags: ['big', 'pretty'] },

      // Drowned Catacombs
      bone_rosary:     { name: 'Bone rosary', tombs: 'catacombs', value: [10, 22], weight: 'light', rarity: 10, depth: 0, mesh: 'beads', material: 'bone', tags: ['old', 'pretty'] },
      glass_shard:     { name: 'Stained-glass shard', tombs: 'catacombs', value: [15, 30], weight: 'light', rarity: 8, depth: 0, mesh: 'shard', material: 'gem', tags: ['pretty', 'shiny'] },
      saint_skull:     { name: 'A saint\'s skull', tombs: 'catacombs', value: [25, 45], weight: 'light', rarity: 6, depth: 0.1, mesh: 'skull', material: 'bone', tags: ['old'] },
      gold_candlestick: { name: 'Gold candlestick', tombs: 'catacombs', value: [35, 60], weight: 'medium', rarity: 5, depth: 0.2, mesh: 'candlestick', material: 'gold', tags: ['shiny'] },
      silver_censer:   { name: 'Silver censer', tombs: 'catacombs', value: [40, 70], weight: 'medium', rarity: 5, depth: 0.25, mesh: 'censer', material: 'silver', tags: ['shiny', 'old'] },
      gilded_icon:     { name: 'Gilded icon', tombs: 'catacombs', value: [45, 80], weight: 'medium', rarity: 4, depth: 0.3, mesh: 'icon', material: 'gold', tags: ['pretty', 'old'] },
      bishop_crozier:  { name: 'Bishop\'s crozier', tombs: 'catacombs', value: [55, 90], weight: 'heavy', rarity: 3, depth: 0.35, mesh: 'crozier', material: 'silver', tags: ['shiny', 'big'] },
      stone_angel:     { size: 0.9, name: 'Weeping stone angel', tombs: 'catacombs', value: [110, 170], weight: 'twoHanded', rarity: 2.5, depth: 0.45, mesh: 'angel', material: 'stone', tags: ['big', 'old'] },
      reliquary:       { name: 'Golden reliquary', tombs: 'catacombs', value: [160, 240], weight: 'light', rarity: 0, depth: 1, mesh: 'reliquary', material: 'gold', tags: ['shiny', 'old'] },
      monstrance:      { size: 0.8, name: 'Great monstrance', tombs: 'catacombs', value: [260, 380], weight: 'twoHanded', rarity: 0, depth: 1, mesh: 'monstrance', material: 'gold', tags: ['big', 'shiny'] }
    },
    shop: ['torch', 'oil_flask', 'flash_powder', 'club', 'spade', 'whisper_shell', 'recall_totem'], // left to right on Mortimer\'s rack

    // Gutbucket upgrades: bought at the tinkers' board in Craig's camp, kept for the campaign.
    upgrades: {
      lantern_mast:   { name: 'Lantern mast', price: 150, what: 'A bright beacon, seen through fog and sandstorms' },
      faster_balloon: { name: 'Faster balloon', price: 250, what: 'Every fare costs a quarter less', fare: 0.75 },
      scrying_bowl:   { name: 'Scrying bowl', price: 300, what: 'Hold Tab and press E: every monster on the map, for a moment', scrySeconds: 6, cooldown: 45 },
      // The oil barrel on deck: without it, the only refill is Mortimer's oil flask.
      oil_barrel:     { name: 'Lantern refill', price: 200, what: 'An oil barrel on deck: stand by it and your lantern fills up' }
    },
    improvements: ['oil_barrel', 'lantern_mast', 'faster_balloon', 'scrying_bowl'], // left to right on the tinkers' board
    // The gangway: anyone can pull it up (E, from the deck) or let it down (E, from either end).
    // Up, nothing climbs aboard or reaches over the rail, and monsters that come looking give up and
    // wander off for a while (shunSeconds) once they're within shunRange and can see it.
    gangway: { shunRange: 8, shunSeconds: 20 },

    // Omens: the weather over a destination, rolled per day and painted on Mortimer's chart before you go.
    // loot scales everything in the tomb; danger scales the danger budget. fogOutside/fogColor thicken the
    // air outside; lantern and moon scale the light.
    omens: {
      chance: 0.35, fromNight: 2,
      list: {
        fog:       { name: 'Fog', weight: 3, loot: 1.15, danger: 1.1, fogOutside: 0.12, fogColor: 0x4c505a },
        bloodmoon: { name: 'Blood Moon', weight: 2, fromNight: 3, loot: 1.35, danger: 1.6, spawnEvery: 0.6, extraMax: 1, moonColor: 0xd23a22 },
        eclipse:   { name: 'Eclipse', weight: 2, loot: 1.25, danger: 1.1, lantern: 0.5, moon: 0.3, moonColor: 0x2a1c14 },
        sandstorm: { name: 'Sandstorm', weight: 8, tombs: ['pharaoh'], loot: 1.3, danger: 1.1, fogOutside: 0.3, fogColor: 0x6e5636 },
        flood: { name: 'Flood', weight: 8, tombs: ['catacombs'], loot: 1.3, danger: 1.1, floodPace: 0.65 } // the bells come sooner, one after another
      }
    },

    // Cosmetics: won by milestones, kept between campaigns, hung on the wardrobe in Craig's camp.
    // Only looks: nothing here makes a goblin any better at anything.
    cosmetics: {
      crown:      { name: 'Craig\'s Spare Crown', slot: 'hat', how: 'Beat the Cut with a single Frenzy haul' },
      nemes:      { name: 'Pharaoh\'s headcloth', slot: 'hat', how: 'Sell a sarcophagus lid to Craig' },
      earring:    { name: 'Brass ear ring', slot: 'ear', how: 'Pay Craig his Cut' },
      eyepatch:   { name: 'Eye patch', slot: 'eye', how: 'Die. Craig hatches you a new goblin, mostly the same' },
      bloodglass: { name: 'Blood-glass lantern', slot: 'lantern', how: 'Live through a Blood Moon', color: 0xff4a2a }
    },
    wardrobe: ['crown', 'nemes', 'earring', 'eyepatch', 'bloodglass'], // hook order, left to right as you face the rack

    // Where the Gutbucket can fly. Only charted destinations with a built tomb can be picked.
    travel: [
      // short: what Mortimer's chart has room to paint under the pin (the prompt says the full name)
      { id: 'craig', name: 'Craig\'s Warren', short: 'Craig\'s', cost: 0, charted: true, craig: true }, // selling uses up the day
      { id: 'barrow', name: 'Barrow Mounds', short: 'Barrow', cost: 0, charted: true },
      { id: 'ossuary', name: 'Dwarf Ossuary', short: 'Ossuary', cost: 0, charted: true },
      { id: 'pharaoh', name: 'Pharaoh\'s Tomb', short: 'Pyramid', cost: 250, charted: true },
      { id: 'galleon', name: 'Sunken Galleon', short: 'Galleon', cost: 350, charted: true },
      { id: 'mushroom', name: 'Mushroom Warren', short: 'Mushrooms', cost: 200, charted: true },
      { id: 'yomi', name: 'Yomi Shrine', short: 'Shrine', cost: 400, charted: true },
      { id: 'terracotta', name: 'Terracotta Mausoleum', short: 'Mausoleum', cost: 500, charted: true },
      { id: 'catacombs', name: 'Drowned Catacombs', short: 'Catacombs', cost: 300, charted: true }
    ],

    // Sealed doors carved with runes. Mortimer translates them through the Jawbone.
    // Monsters. Each has one rule, a tell before it\'s dangerous, and a counter.
    monsters: {
      mimic: {
        sight: { fov: 360, lit: 7, dark: 6, crouch: 0.7, search: 3 }, // no eyes to speak of; it senses you all round
        chance: 0.3, firstNightChance: 0.2, // share of chests that are mimics
        hp: 3, bite: 55, awakeBite: 40, biteCooldown: 1.6, hopSpeed: 1.7,
        chaseRange: 7, calmAfter: 6, revealRange: 0.8, stunSeconds: 1.2, drops: [1, 2]
      },
      ranger: {
        height: 1.75, wanderSpeed: 1.3, huntSpeed: 2.6, rushSpeed: 3.6,
        hearing: 1.0,            // multiplies every noise\'s radius
        shootRange: 11, drawSeconds: 0.9, arrowDamage: 45, arrowHitRadius: 0.9, shootCooldown: 3.5,
        stab: 40, stabRange: 0.9, stabCooldown: 1.5, sniffSeconds: 3.5
      },
      // Ghoul: a lean grey thing that lopes on all fours. It hunts by sight and runs faster than a
      // goblin walks, slower than one sprints: see it first, then run (and break its line of sight).
      // Terracotta Soldier: one of the clay army, and not a statue at all. It only moves while no goblin
      // is looking at it (facing it, in line of sight, within your light, or within arm's reach in the
      // dark). It knows where you are within senseRange. You hear the clay grind when it moves.
      soldier: { height: 1.9, speed: 3.4, hit: 55, hitRange: 1.05, hitCooldown: 1.4, senseRange: 20,
        watch: { fov: 100, lit: 14, dark: 2.5 }, grindEvery: 0.35 },
      ghoul: { sight: { fov: 140, lit: 16, dark: 9, crouch: 0.6, search: 5 }, height: 1.1, speed: 3.7, wanderSpeed: 1.3,
        hit: 30, hitRange: 1.0, hitCooldown: 1.2, flashStun: 3, shriekEvery: [9, 16] },
      // The Giant: out on the open ground from 11 p.m., in every tomb. It sees far (it's tall), stomps so
      // the ground shakes, and if it reaches a goblin that isn't on the Gutbucket or inside, it picks it up.
      // It walks at a goblin's walk and hunts a little faster: only a sprint gets away.
      giant: { sight: { fov: 220, lit: 40, dark: 22, crouch: 0.55, search: 6, outside: true }, fromHour: 23, speed: 1.6, huntSpeed: 3.8,
        grabRange: 1.9, radius: 1.3, stepEvery: 0.85, stepLoud: 1.2 },
      knight: {
        sight: { fov: 300, lit: 34, dark: 18, crouch: 0.5, search: 4, outside: true }, // a rider looks all round
        fromHour: 27, patrolSpeed: 2.5, chargeSpeed: 6.5, accel: 3.5, turnRate: 1.5, chargeTurnRate: 1.1,
        hit: 70, hitRange: 1.3, hitCooldown: 2, overshootSeconds: 1.4, radius: 0.8
      },
      // Slow, but always knows where cursed loot is: the goblin carrying it, the spot it was dropped,
      // or the Gutbucket\'s gangway if it\'s aboard.
      mummy: { sight: { fov: 110, lit: 8, dark: 4.5, crouch: 0.6, search: 6 }, height: 1.8, speed: 1.15, hit: 45, hitRange: 1.1, hitCooldown: 1.8, flashStun: 3,
        reaggro: 6 }, // parked at the gangway for loot aboard, it goes for any goblin this close
      // Wakes when the sarcophagus lid is lifted. Fast, tough, and wants its lid back.
      pharaoh: { sight: { fov: 140, lit: 18, dark: 11, crouch: 0.6, search: 8 }, height: 1.9, speed: 3.0, riseSeconds: 2.5, hit: 70, hitRange: 1.2, hitCooldown: 1.5, flashStun: 1.5, reaggro: 8 },
      // Pours from cracked jars; chews anyone standing still; keeps out of lantern light.
      scarabs: { crackRange: 2.5, speed: 1.8, chewRange: 1.1, chewPerSecond: 12, stillSpeed: 0.6, lifeSeconds: 45,
        lightRadius: { lantern: 2.3, belt: 1.1, torch: 3.2 } },
      // A statue that weighs your heart: carry more than maxLoad past it and it bites.
      jackal: { maxLoad: 4, glowRange: 5, biteRange: 2.0, bite: 60, biteCooldown: 2.5 },
      // Nearly invisible. Drifts about, swallows loot it rolls over (it floats inside), and
      // engulfs goblins. Slower than a walking goblin; feels footsteps; blind to flash-powder.
      cube: { height: 1.9, wanderSpeed: 0.6, huntSpeed: 1.0, feelRange: 7, feelCrouched: 2.5, hearing: 0.6,
        engulfRange: 0.85, swallowRange: 0.9, digest: 12, struggleSeconds: 1.8, spitStun: 3, hp: 6 },
      // A roost of bats. Harmless, but loud: wakes to lantern light and footsteps, flies at
      // whoever woke it shrieking (every monster hears), and swirls round anyone standing,
      // snuffing their lantern. Crouch and it passes over.
      // The Drowned Captain: slow and relentless. He hunts by sight, searches long, and
      // follows anywhere, out of the wreck and up the beach. Only the Gutbucket stops him.
      // Chochin-obake: a paper lantern that's awake. It hangs still and watches; if it sees you,
      // it shrieks, and the Onryo comes to where you were. Keep out of its sight.
      chochin: { sight: { fov: 110, lit: 12, dark: 5, crouch: 0.55, search: 0 }, turnSpeed: 0.35, shriekLoud: 1.0, cooldown: 6 },
      // Onryo: the shrine's hunter. She hunts by sight, is quicker than a walking goblin but not a
      // sprinting one, and searches a long time where she lost you. Hide.
      onryo: { sight: { fov: 120, lit: 15, dark: 8, crouch: 0.55, search: 10 }, height: 1.7, speed: 3.0, wanderSpeed: 1.2,
        touch: 50, touchRange: 1.0, touchCooldown: 1.8, flashStun: 3, wailEvery: [7, 12] },
      // Gashadokuro: a skeleton the height of a house, out in the bamboo from 1 a.m. It hunts by
      // sound, rattling as it comes, and can't fit inside. Outside, stay quiet.
      gashadokuro: { fromHour: 25, hearing: 1.3, speed: 2.2, huntSpeed: 3.2, hit: 90, hitRange: 2.4, hitCooldown: 2.5, rattleEvery: 0.9, radius: 1.4, searchSeconds: 6 },
      // The Myconid: a big walking mushroom. Hunts by sight (glowcaps light you up for it) and
      // puffs spore clouds ahead of it while it hunts. Flash-powder dazzles it.
      myconid: { sight: { fov: 120, lit: 13, dark: 7, crouch: 0.55, search: 7 }, height: 2.0, speed: 1.9, hit: 55, hitRange: 1.2, hitCooldown: 1.7,
        puffEvery: 5, flashStun: 3 },
      // Spore Phantoms: what you see after breathing spores. They look like real monsters, walk at
      // you and vanish when they get close. They never make a sound and never hurt anyone.
      phantoms: { every: [4, 9], life: 14, speed: 2.2, vanishRange: 1.6, max: 2, from: 6, near: 11,
        kinds: ['ranger', 'mummy', 'cube', 'myconid', 'captain'] },
      captain: { sight: { fov: 150, lit: 16, dark: 9, crouch: 0.55, search: 12 }, height: 1.9, speed: 1.7, hit: 60, hitRange: 1.2, hitCooldown: 1.6,
        flashStun: 2.5, bellEvery: [9, 16] },
      // The Crab Gang: grabs loot left lying about and carries it off into the water.
      // Catch up with them and they drop it and scatter; they nip goblins standing in them.
      // The Bard: an adventurer with a lute and a gift for voices. Co-op only, in the late tombs after
      // midnight. It lurks in the dark; every so often it plucks a note (the tell), then speaks with the
      // voice of a fallen crewmate who let it borrow theirs (a setting), to draw someone close. Come within
      // strikeRange and it strikes, then slips away. The counter: lantern signals. A real crewmate can flash back.
      bard: { speakEvery: [16, 28], luteLead: 1.3, strikeRange: 1.5, hit: 60, hitCooldown: 3, fleeSeconds: 6, speed: 2.8, wanderSpeed: 1.0, height: 1.8 },
      // The Bone-Thief: a skeletal scavenger that goes for loot you've put down and drags it off toward the
      // water (the crabs' rule). Catch up and it drops it and flees. It never fights.
      thief: { speed: 2.8, carrySpeed: 2.2, senseRange: 18, grabRange: 0.6, scareRange: 2.2, scatterSeconds: 3, nip: 0, nipEvery: 1, hp: 2, height: 1.2 },
      // Drowned Hands: pale hands under the flood. They drift toward a goblin wading nearby and, if they
      // reach one, hold it fast and squeeze. They can't leave the water.
      hands: { speed: 1.4, senseRange: 9, grabRange: 0.9, holdSeconds: 3, squeeze: 9, cooldown: 5, minDepth: 0.35, height: 0.3 },
      crabs: { speed: 2.2, carrySpeed: 1.6, senseRange: 11, grabRange: 0.5, scareRange: 1.3, scatterSeconds: 4, nip: 4, nipEvery: 1.2, hp: 2 },
      bats: { wakeLit: 4.5, wakeDark: 2.0, hearing: 0.5, wakeLoud: 0.5, flySpeed: 6, shriekEvery: 0.35, shriekLoud: 0.9,
        passRange: 1.4, swirlSeconds: 2.2, restSeconds: 10 },
      flashRange: 9
    },

    // How monsters that hunt by sight see. Each can override these in its own sight block.
    // fov: degrees of the view cone; lit/dark: meters it spots a goblin with a light / without;
    // crouch: range multiplier for a crouching goblin; near: always noticed this close;
    // search: seconds spent searching where it last saw you before giving up.
    // Cover: a prop at least coverCrouch tall hides a crouching goblin behind it, coverStand a standing one.
    sight: { fov: 110, lit: 14, dark: 7, crouch: 0.55, near: 1.4, search: 5, coverCrouch: 0.55, coverStand: 1.3 },
    // Warning sounds. A monster that starts hunting without seeing you (it heard you, a lantern
    // told it, cursed loot) makes an 'alert'; a hunter this close to a goblin makes a 'closing'
    // cue, at most once every closeEvery seconds. Monsters not listed never give the close cue.
    cues: { closeEvery: 5, closeRange: { mummy: 3.5, pharaoh: 4, captain: 3.5, onryo: 3.5, myconid: 3.5, gashadokuro: 6, cube: 3, mimic: 2.5, ghoul: 4, giant: 9, soldier: 3, hands: 2.5 },
      noAlert: ['ranger', 'knight', 'chochin', 'jackal', 'scarabs', 'crabs', 'bats', 'thief', 'hands', 'soldier', 'bard'] },

    // Wanderers can turn up in any tomb: common in their home tombs, rare elsewhere (at most
    // maxAway, and only from awayFrom o'clock). Natives are listed in each tomb's natives table.
    // The Mimic hides among chests everywhere; the Knight rides outside every tomb after 3 a.m.
    wanderers: {
      ranger: { home: ['barrow'], cost: 2.5, maxHome: 4, costAway: 3.5, maxAway: 1, awayFrom: 18 },
      cube:   { home: ['ossuary'], cost: 2.5, maxHome: 2, costAway: 3, maxAway: 1, awayFrom: 22 },
      ghoul:  { home: ['barrow', 'ossuary', 'pharaoh'], cost: 2, maxHome: 3, costAway: 2.5, maxAway: 1, awayFrom: 20 },
      bats:   { home: ['ossuary', 'mushroom'], roostsHome: [3, 4], roostsAway: [0, 1] } // roosts are placed with the tomb
    },
    // The danger budget: Rangers cost points; the budget grows through the night. Raised 30% with the tombs' size.
    danger: { base: 3.25, perHour: 0.52, midnight: 1.95, perNight: 0.08, maxPerNight: 1.6 },

    runes: { glyphs: 8, codeLength: 3, translateSeconds: 5, openSeconds: 45, grumbleNoise: 0.6, extraSealChance: 0.5 },
    map: { revealRadius: 1 }, // cells around the goblin that go on Mortimer\'s map
    materials: {
      bronze: { color: 0xa8743a, shine: 40 }, silver: { color: 0xc9ccd2, shine: 80 }, gold: { color: 0xe3b341, shine: 90 },
      bone: { color: 0xd8cfb4, shine: 5 }, amber: { color: 0xd0801c, shine: 60 }, iron: { color: 0x5d5c58, shine: 20 },
      stone: { color: 0x7d8076, shine: 0 }, clay: { color: 0x7a5238, shine: 5 },
      wood: { color: 0x6a4a2c, shine: 5 }, cloth: { color: 0x8a7a5a, shine: 0 },
      faience: { color: 0x2f79b8, shine: 70 }, alabaster: { color: 0xe6dfcc, shine: 30 }, papyrus: { color: 0xd8c696, shine: 0 },
      granite: { color: 0x4a443c, shine: 20 },
      brass: { color: 0xb8913a, shine: 60 }, pewter: { color: 0x8f9496, shine: 50 }, gem: { color: 0xb03a6a, shine: 100 },
      mithril: { color: 0xcfdcea, shine: 110 }, fungus: { color: 0x9a6a8a, shine: 10 },
      jade: { color: 0x4a9a6a, shine: 70 }, lacquer: { color: 0x9a1e1a, shine: 80 },
      glass: { color: 0x3f6a3a, shine: 90 }, pearl: { color: 0xeae4d6, shine: 100 }
    },

    // Craig\'s economy. Every third night is Cut night; he pays more the closer it gets.
    // Death. Solo: Mortimer lifts off a moment after the goblin drops. Craig charges to hatch
    // a replacement for every goblin that died or was left behind; what can\'t be paid is added to the next Cut.
    // Co-op: carrying a fallen crewmate (speed factor, height over the shoulder) and lantern signals.
    coop: { bodySlow: 0.6, bodyHeight: 0.8, signalSeconds: 0.45 },

    death: { panicSeconds: 2.5, feeBase: 30, feePerCut: 15, bodyAboardFactor: 0,
      causes: {
        mimic: 'Eaten by the furniture.', ranger: 'Stabbed by someone who couldn\'t even see you.', arrow: 'Shot by someone who couldn\'t even see you.',
        knight: 'Lanced. Thoroughly.', fall: 'Fell over. Fatally.', ghoul: 'Run down by a ghoul. You were walking.',
        giant: 'Picked up by a giant. You did not come down.', soldier: 'You looked away.', hands: 'Held under by something in the water.', bard: 'Followed a friend\'s voice. It wasn\'t your friend.',
        mummy: 'Hugged by a mummy. It didn\'t let go.', pharaoh: 'The Pharaoh wanted his lid back.', scarabs: 'Eaten by beetles. Slowly.',
        jackal: 'Your heart was too heavy. So was your bag.', sand: 'Buried. Very thoroughly.',
        cube: 'Dissolved. Slowly, then all at once.', cavein: 'The ceiling came down. You were under it.',
        chasm: 'Fell into the dark. Still falling, probably.', cart: 'Run over by a mine cart. On a straight track.',
        myconid: 'Stamped flat by a mushroom. Say it out loud.',
        onryo: 'She found you. She always does, eventually.', gashadokuro: 'Stepped on by a skeleton the size of a house.',
        drowned: 'Drowned. The tide doesn\'t wait.', captain: 'The Captain went down with his ship. So did you.', crabs: 'Nipped to death by crabs. Very slowly.'
      } },
    economy: {
      // A cycle is 4 days. Each day is either a night in a tomb or a visit to Craig; day 4 is
      // always Craig, for the Cut. Between days the Gutbucket waits in the sky and you choose.
      startGold: 50, firstCut: 150, cutGrowth: 1.4, cutAdd: 50, cycle: 4,
      rates: [0.3, 0.5, 0.75, 1.0],    // what Craig pays, by day of the cycle, if you visit him that day
      spikeChance: 0.1, spikeBonus: 0.35, // a rare good mood
      cravingBonus: 1.5,
      frenzyChance: 0.25, frenzyFromNight: 2, frenzyRate: 1.5, // a Frenzy day: last night's loot sells at 150% if you go that day
      frenzyUnlock: 'Craig\'s Spare Crown' // cosmetic for a Frenzy haul that beats the Cut on its own
    },
    // What Craig can crave. Items carry matching tags.
    cravings: {
      shiny: { label: 'something SHINY', line: 'I want something SHINY. Shiny shiny shiny.' },
      pretty: { label: 'something PRETTY', line: 'Something pretty. For my collection. Of pretty things.' },
      big: { label: 'something BIG', line: 'Bring me something BIG. I like big.' },
      old: { label: 'something OLD', line: 'Old stuff. Dusty stuff. The dustier the better.' }
    },

    // Mortimer\'s lines, keyed by the events the game logic sends.
    // Mortimer's first-night lessons (a campaign started with them on). Each step is said once, then
    // `nag` is said again every nagSeconds until its goal is met (the goals live in index.html, `LESSON_DONE`).
    // `where` is the place the step waits for: sky, tomb or craig. The first tomb night has less danger.
    lessons: {
      danger: 0.5, nagSeconds: 30,
      steps: [
        { id: 'hello', where: 'sky', say: ['Welcome aboard the Gutbucket. I\'m Mortimer. The skull on the post. Don\'t stare.', 'Craig owns you, me and this boat. We rob tombs, he takes his Cut. Let\'s get you started.'] },
        { id: 'walk', where: 'sky', say: ['Have a walk round the deck. W, A, S and D, and look with the mouse.'], nag: 'Go on. Walk about. W, A, S, D.' },
        { id: 'chart', where: 'sky', say: ['See my chart on its post? Point at the Barrow pin. That\'s where we\'re going. Cheap, close, and free.'], nag: 'The chart, goblin. The board on the post. Look at the pins.' },
        { id: 'helm', where: 'sky', say: ['Good. Now come to me at the helm and hold E. I\'ll fly us down.'], nag: 'Over here. The helm. Hold E.' },
        { id: 'lantern', where: 'tomb', say: ['The Barrow Mounds. Old kings, old junk, very few locks.', 'That\'s your lantern. F puts it out and lights it again. It burns oil: the bar with the drop, bottom left.'], nag: 'Try the lantern. F.' },
        { id: 'enter', where: 'tomb', say: ['Down the gangway and into the mound. The door\'s the dark bit.'], nag: 'The mound, goblin. Down the gangway, in the door.' },
        { id: 'crouch', where: 'tomb', say: ['Low roof? C to crouch. Crouching\'s quieter, too.'], nag: 'C to crouch. Try it.' },
        { id: 'loot', where: 'tomb', say: ['Anything shiny: point at it and press E. You\'ve four hands of room, and heavy things slow you down and make you loud.'], nag: 'Find something shiny and take it. E.' },
        { id: 'hide', where: 'tomb', say: ['Something\'s down here with you. Most things hunt by sight.', 'If one sees you, get out of its sight. Crouch behind a crate or a barrel and it loses you. Don\'t run into the dark.'], nag: 'Crouch behind a crate. Just to see how it feels.' },
        { id: 'map', where: 'tomb', say: ['Lost? Hold Tab for my map. I draw in what you\'ve seen.'], nag: 'Hold Tab. My map.' },
        { id: 'home', where: 'tomb', say: ['That\'ll do for a start. Bring it back aboard. Drop it on the deck, or stow it at the hatch with E.'], nag: 'Back to the boat with it. Loot only counts once it\'s aboard.' },
        { id: 'bell', where: 'tomb', say: ['The night runs to six. I ring a bell at five: be aboard by six or I leave without you.', 'Hold E at my helm to go early. Carry on, if you like. Nothing else I can teach you that dying won\'t.'] },
        { id: 'sky2', where: 'sky', say: ['Up in the clouds again. Your haul\'s laid out on the deck.', 'Craig\'s pin on the chart to sell, or another tomb to keep robbing. Selling uses up a day. Day four is always Craig\'s, for his Cut.'] },
        { id: 'sell', where: 'craig', say: ['Craig\'s Warren. Throw your loot in his pit: right click. His mood board on my mast says what he pays today.'], nag: 'Throw something in the pit. Right click.' },
        { id: 'cut', where: 'craig', say: ['Every fourth day he takes his Cut. Pay it, or it\'s you in the pit.', 'That\'s the lessons done. The rest you learn by dying.'] }
      ]
    },
    lines: {
      landed: ['We\'re down. Dawn\'s at six. I leave at six. Understood?', 'Barrow\'s that way. Bring back something Craig can\'t insult.', 'Mind the dark. Actually, mind the loot. The dark is free.'],
      bell: ['That\'s the bell! One hour, then I\'m gone, with or without you.', 'Five o\'clock! Back to the boat, or become part of the scenery.'],
      liftEarly: ['Leaving already? Fine by me. Craig can do the shouting.', 'Up we go. Hope that\'s everything.'],
      liftDawn: ['Dawn! Up, up, up!', 'Sun\'s coming. Ropes off. Goodbye, barrow.'],
      leftBehind: ['Sorry! Schedule\'s a schedule!', 'I did ring the bell. Twice. Well, once.'],
      stow: ['Into the hold. I\'ll write it down.', 'Noted. In ink.', 'That\'s going in the ledger.'],
      panic: ['They got you! I\'m going, I\'m going!', 'Oh no. Oh no no no. Ropes off!', 'Nope. Leaving. Sorry. Leaving.'],
      twoHands: ['That one needs both hands. Put the rest down.'],
      bought: ['Pleasure doing business. Mostly the pleasure of taking your gold.', 'No refunds.', 'A fine choice. For a goblin.'],
      broke: ['You can\'t afford that. I checked. Twice.', 'Gold first, goblin.'],
      translated: ['It says KEEP OUT. Rude. Anyway, it\'s open.', 'Something about a curse. Probably fine. It\'s open.', 'It says PUSH. So I pushed. Magically.'],
      doorShut: ['That door\'s closed again, by the way.'],
      noStowTool: ['Tools stay with you. The hold is for loot.'],
      destination: ['Barrow Mounds it is. Again.', 'Plotted. Try not to fall out.'],
      omen: { fog: ['Fog down there. You won\'t see much outside. Neither will I. Worth more, though.'],
        bloodmoon: ['A Blood Moon. Everything down there is awake and hungry. The loot\'s worth it. Probably.'],
        eclipse: ['An eclipse. Your lantern will be half a lantern. Loot shines brighter in the dark, they say.'],
        flood: ['Flood tonight. The bells will come quick. Don\'t be at the bottom when they do.'],
        sandstorm: ['Sandstorm. You won\'t see your own ears outside. Follow the beacon home.', 'Sand in the wind. Keep the boat\'s light in sight, or you won\'t find it again.'] },
      upgraded: ['Fitted. I\'ll try not to break it.', 'There. The Gutbucket thanks you. Silently.'],
      fitted: ['That\'s already fitted. I\'m not fitting it twice.'],
      unlocked: ['Something new for the wardrobe. It\'s on a hook in Craig\'s camp.', 'Ooh. That goes on the wardrobe in Craig\'s camp. Try it on.'],
      recall: ['Got you! Up you come!', 'Hold on to something. Like your lunch.'],
      gangwayUp: ['Gangway\'s up. Nothing\'s climbing aboard now. Including you, mind.', 'Up it comes. Knock if you want in.'],
      gangwayDown: ['Gangway\'s down.'],
      giveUp: ['It\'s seen the gangway\'s up. It\'s wandering off. Sulking, I think.'],
      ghoul: ['That thing runs on all fours. Don\'t walk away from it. RUN.', 'A ghoul! Sprint, and get round a corner!'],
      giant: ['Feel that? Something BIG is walking about out there. Stay inside, or stay on the boat.', 'A giant! Don\'t be out in the open, and if it sees you, run!'],
      locked: ['Not yours yet.'],
      scry: ['Let\'s have a look in the bowl. Ooh. Busy down there.', 'The water shows all. Mostly teeth.'],
      scryWait: ['The bowl needs a moment. It\'s a bowl, not a miracle.'],
      knight: ['Hooves! Something\'s out on the moor. Stay in the dark, or stay on the boat.', 'A knight! On a HORSE! Don\'t be out in the open!'],
      pyramid: ['Sand. So much sand. The pyramid\'s that way.', 'Cursed things in there. Don\'t get attached. Actually, do. They\'re worth double.'],
      cursed: ['That one\'s cursed. I can smell it from here. Something down there knows you took it.', 'Cursed! Lovely. Now it knows where you are.'],
      pharaoh: ['What did you DO? Run! Run to the boat!', 'I heard that from up here. Bring the lid. And your legs.'],
      sandTrap: ['Sand! Get out of that room!', 'Floor\'s full of sand. Room\'s next. Move!'],
      buried: ['You\'re buried. Wriggle! Or dig, if you brought a spade.'],
      jackal: ['That statue\'s looking at you. It doesn\'t like heavy hearts. Or heavy bags.'],
      scarabs: ['Beetles! Keep moving. They hate the light.'],
      mummyAtShip: ['There\'s a mummy at the gangway. It wants something you brought aboard.'],
      mimicBite: ['That chest had TEETH. Noted.', 'Throw something at chests first. I thought everyone knew that.'],
      mimicDead: ['You killed a chest. Mortimer is proud. Mortimer is also me.'],
      ranger: ['Someone else is down there. Walk soft.'],
      uncharted: ['No charts for that one yet. Ask me again later.'],
      spotted: ['It\'s seen you! Get out of sight!', 'Spotted! Break line of sight. Get behind something!'],
      lost: ['It lost you. Stay down a moment longer.', 'It\'s given up. Probably. Stay low.'],
      mine: ['The Ossuary. Dwarves buried their dead where they dug. Mind the holes.', 'Mine\'s that way. If the ceiling rumbles, don\'t be under it.'],
      engulfed: ['You\'re in the jelly! Wriggle out!', 'That\'s a cube! Kick! Squirm! Something!'],
      cubeSeen: ['Loot floating in mid-air? That\'s not magic. Walk away from it.'],
      bats: ['Bats! Get down and let them pass.', 'Shrieking! Everything down there heard that.'],
      snuffed: ['They put your lantern out. Light it again, quick.'],
      rumble: ['That ceiling\'s groaning. Move!', 'Rumbling! Out from under it!'],
      cavein: ['Cave-in! Everybody still got all their bits?'],
      cart: ['A mine cart! Loud as sin, but it carries anything.'],
      chasmDrop: ['That went down a long way. Let\'s not follow it.'],
      pit: ['The Catacombs. Down the switchback to the bottom. Keep to the wall: it\'s a long way down.', 'Listen for the bell. Every time it rings, the water comes up.'],
      bard: ['That voice... that\'s not them. They\'re dead. Flash your lantern, and see who flashes back.', 'Someone\'s playing a lute down there. Nobody we know plays the lute.'],
      floodBell: ['The bell! The water\'s coming up. Get to higher ground.', 'That\'s the bell. Up, up, before it\'s over your head.'],
      hands: ['Something in the water has you! Kick!', 'Hands! Stay out of the deep water!'],
      thief: ['Something\'s taken your loot. Skinny thing, all bones. After it!', 'Don\'t leave loot lying about down there. Things take it.'],
      cliff: ['The Mausoleum. Down the canyon, through the gate. Mind the statues. Actually, watch the statues.', 'An army of clay in there. Keep your eyes on them. Don\'t ask me why. Just do.'],
      soldier: ['That statue MOVED. Don\'t look away from it!', 'They only move when nobody\'s watching. So WATCH.'],
      shrine: ['The Yomi Shrine. Something in there walks the halls. Stay out of its sight.', 'Shrine\'s through the red gate. Creep on the singing floors, and mind the paper walls.'],
      nightingale: ['Singing floors! Creep, or the whole shrine hears you.'],
      paper: ['Paper walls. With your lantern lit, you\'re a shadow puppet to anything on the other side.'],
      chochin: ['That lantern just LOOKED at you! She heard it. Move, and hide!', 'Lantern\'s awake! It\'s calling her!'],
      onryo: ['A woman in white. Don\'t let her see you. Hide, and stay hidden.', 'She\'s searching. Stay down. Stay dark.'],
      gashadokuro: ['Something enormous is rattling about in the bamboo. Quietly. Very quietly.', 'Bones. Big bones. Stay in, or stay silent.'],
      caves: ['The Warren. Everything down there glows. That includes you, if you stand near it.', 'Mushrooms. Big ones. Don\'t breathe the dust. Or do, and tell me what you see.'],
      spored: ['You breathed it, didn\'t you. You\'ll see things for a bit. Some of them are real.', 'Spores! If it makes no sound, it isn\'t there. Probably.'],
      glowStep: ['Step on the glowing ones and the whole cave knows where you are.'],
      myconid: ['That\'s a Myconid. Get behind a cap and stay behind it.', 'Something big and soft is walking about. Hide!'],
      phantomGone: ['Just spores. Probably. Keep moving.'],
      wreck: ['A galleon, on its side. The tide comes back in tonight, so the bottom of the ship goes first.', 'Wreck\'s that way. Deep loot first, before the sea takes it back.'],
      tideRising: ['Tide\'s coming in. The lower holds are going under.', 'Water\'s rising. Anything left down there is fish food.'],
      drownedLoot: ['That one\'s gone. The sea\'s got it now.'],
      underwater: ['Head above water! You\'re not a fish. I checked.'],
      captain: ['A bell. Underwater. That\'s the Captain. Stay out of his sight.', 'He\'s coming up from the hold. Hide, or run for the boat!'],
      crabs: ['Crabs! They\'ve got your loot! After them!', 'Thieving crabs. Don\'t put anything down.'],
      frenzy: ['Message from Craig: "I\'m HUNGRY. Bring me last night\'s haul TODAY and I\'ll pay double. Almost."',
        'Craig\'s in a Frenzy today! Last night\'s loot sells for half again, if we go now.'],
      // Between days, up in the sky.
      sky: ['Where to? Craig\'s mood is on the board. Pick a pin on my chart, then hold the helm.', 'Up here it\'s just us and the moon. Choose where we go.'],
      skyFirst: ['Right. Pick a tomb on my chart, hold the helm, and we go digging. Craig\'s pin is for selling. That uses up a day.'],
      forcedCraig: ['It\'s Cut day. We\'re going to Craig whether you like it or not.', 'Day four. Craig\'s waiting. The chart\'s just for show today.'],
      craigPicked: ['Craig\'s it is. That\'s a day gone, mind.', 'Off to sell. He\'d better be in a good mood.'],
      noFare: ['Can\'t afford that fare. Pick something cheaper.'],
      onlyCraig: ['Not today. Today is Craig\'s.']
    },

    // Craig\'s lines in the throne room.
    craig: {
      greet: [
        ['Day one? I\'m grumpy. Grumpy pays thirty percent.', 'You\'re early. My prices are low and my patience is lower.'],
        ['Day two. I\'m peckish. Half price, take it or leave it.', 'Peckish, I am. Show me something.'],
        ['Day three. I\'m hungry. Three quarters. Don\'t push it.', 'Hungry now. Nearly full price. Nearly.'],
        ['CUT DAY. Full price, and then I take my share.', 'Today you pay me. Before that, maybe I pay you. Full price.']
      ],
      spike: ['I\'m in a good mood. Don\'t ruin it.', 'Feeling generous. It won\'t last.'],
      frenzy: ['FRESH! Give it! Give it all!', 'Tonight\'s haul, and quick, before I calm down.'],
      cheap: ['You almost died for THIS?', 'I\'ve sneezed out better than this.', 'Is this a joke? It\'s a small joke.'],
      fine: ['Fine. On the pile.', 'Mm. Acceptable.', 'I\'ll take it. Don\'t get used to it.'],
      good: ['Ooh. Ooh! Fine. It\'s fine.', 'Now THAT is loot.', 'On the pile. Gently. GENTLY.'],
      craved: ['YES. That\'s what I wanted.', 'Finally, someone listens.'],
      hatched: ['Don\'t worry, I\'ve got more of you in the back.', 'Hatched a fresh one. It\'s already disappointing.', 'That one was defective anyway.'],
      debt: ['You owe me. With interest. Mostly the interest.', 'I\'ll put it on your tab. Your tab is my Cut.'],
      nothing: ['Nothing? You brought me NOTHING?', 'An empty boat. How original.'],
      junk: ['A TOOL? I don\'t want your tools. I want TREASURE.', 'Mortimer sold you that. I\'m not buying it back.'],
      keep: ['Keeping it? Your funeral. Literally, maybe.', 'Hoarding. I respect that. I hate it, but I respect it.'],
      cutPaid: ['The Cut\'s paid. Next one\'s bigger. Obviously.', 'Mine now. See you in three nights.'],
      cutBare: ['The bare minimum. My heroes.', 'Just enough. How disappointing.'],
      impressed: ['...Huh. That\'s more than the Cut. Fine. Have a crown. It\'s a spare.'],
      pit: ['Pit. All of you. Now.'],
      sendOff: ['One goblin, one lantern, zero brains. Perfect. Go.', 'Go on. The dead won\'t rob themselves.']
    },

    tombs: {
      // Not a tomb: Craig\'s crater, where loot is sold by throwing it into his pit.
      // Not a place: the Gutbucket alone in the night sky between days.
      sky: {
        layout: 'sky',
        name: 'Over the clouds',
        grid: { w: 14, h: 10 },
        landing: { x: 7, y: 5 },
        palette: {
          wall: 0x5b5249, moss: 0x4a4a36, ceiling: 0x322f28, riser: 0x4e4439, kerb: 0x6a5e50, turf: 0x3b3a2c, fieldWall: 0x544a3f,
          ground: 0x3a3228, bone: 0xcfc6ad, wood: 0x5a4028, root: 0x3a2e22, clay: 0x6b4a33, slab: 0x7c7e74,
          sky: 0x182236, fogOutside: 0x28324a, fogInside: 0x000000, moon: 0xc8d4ec, ambient: 0x8a8aa0, cloud: 0x9aa4bc
        },
        fog: { outside: 0.006, inside: 0.1 },
        moonStrength: 0.55
      },
      warren: {
        layout: 'warren',
        name: 'Craig\'s Warren',
        grid: { w: 26, h: 30 },
        landing: { x: 13, y: 5 },
        pit: { x: 13, y: 15, radius: 4.3, floor: -3.5 }, // cells; radius in meters
        throne: { x: 13, y: 23 },
        torches: [[-6.6, -2.2], [6.6, -2.2], [-6.2, 5.8], [6.2, 5.8]], // meters from the pit\'s center
        board: [-6.2, -5.6],
        // The goblin camp round the pit (meters from the pit's center, like the torches): a log
        // palisade on the crater's edge with a gate behind the landing and a tower at each corner,
        // mud huts [x, z, radius], Craig's treasure heaps [x, z, size], a cookfire, skull totems,
        // and a brazier either side of the throne.
        camp: {
          wallHeight: 6.5,
          gate: 4.5, // half-width of the gate behind the Gutbucket
          huts: [[-17, -18, 2.3], [17, -19, 2.4], [-19.5, -4, 2.2], [19.5, -5, 2.5], [-18.5, 10, 2.4], [18.5, 11, 2.2], [-13, 22.5, 2.3], [13, 22.5, 2.4]],
          hoard: [[-4.6, 15.6, 1.3], [4.6, 15.4, 1.4], [-3.4, 19.8, 1.6], [3.6, 20, 1.5], [0, 22.2, 1.9], [-7.4, 18.2, 1.1], [7.4, 17.8, 1.2],
            [-9, 13.5, 0.8], [9.2, 13.2, 0.8], [-8.5, -10, 0.8], [10, 3.5, 0.7], [-21, 19.5, 1], [21, -13, 0.9], [-4, 25, 1.1], [5, 25.2, 1]],
          cookfire: [-11.5, 1.5],
          totems: [[-6, -13], [6, -13], [-9.5, 9.5], [9.5, 9.5], [-14, 17], [14, 17]],
          braziers: [[-3.3, 12.6], [3.3, 12.6]],
          wardrobe: [7.2, -8.6], // the wardrobe rack: across from Craig's price board, facing the landing
          workshop: [-12.5, -9.5] // the tinkers' board: Gutbucket upgrades for sale, beside Craig's price board
        },
        floorSurface: 'dirt',
        kerbHeight: 3.0,
        fieldWallHeight: 0.05, // the palisade stands on it; the crater's cliffs rise beyond (terrainH)
        palette: {
          wall: 0x5b5249, moss: 0x4a4a36, ceiling: 0x322f28, riser: 0x4e4439,
          kerb: 0x6a5e50, turf: 0x3b3a2c, fieldWall: 0x544a3f, ground: 0x3a3228,
          bone: 0xcfc6ad, wood: 0x5a4028, root: 0x3a2e22, clay: 0x6b4a33, slab: 0x7c7e74,
          sky: 0x141b26, fogOutside: 0x1d1a1c, fogInside: 0x000000,
          moon: 0x9fb2cc, ambient: 0x8a6e58
        },
        fog: { outside: 0.022, inside: 0.1 },
        moonStrength: 0.4
      },
      pharaoh: {
        name: 'Pharaoh\'s Tomb',
        style: 'pyramid', // stepped pyramid, coffins, a royal sarcophagus, painted walls
        grid: { w: 48, h: 57 },
        interior: { x0: 6, y0: 14, x1: 42, y1: 53 },
        landing: { x: 24, y: 5 },
        rooms: { attempts: 117, max: 18, minSize: 3, maxSize: 6, extraLinks: 0.15, extraLinkRange: 16 },
        levels: { top: -0.3, perCell: -0.13, deepest: -3.6 },
        stepQuantum: 0.25,
        kerbHeight: 3.0,
        fieldWallHeight: 1.1,
        ceilings: { entrance: 3.2, chamber: 2.8, burial: 3.4, treasure: 3.8, corridor: 2.1, tunnel: 1.15 },
        surfaces: { entrance: 'sandstone', chamber: 'sandstone', burial: 'sandstone', treasure: 'sandstone', corridor: 'sand', tunnel: 'sand' },
        outsideSurface: 'sand',
        burialChance: 0.45,
        burialProp: 'coffin',
        treasureProp: 'sarcophagus',
        outside: { boulders: 8, ringStones: 0, ringRadius: 5, obelisks: 4 },
        loot: {
          perRoom: 0.15, perRoomDepth: 0.75,
          corridorItems: 3, chests: [1, 4], chestItems: [1, 2],
          slabGoods: 0.35,
          treasure: { plinth: 'golden_death_mask', lid: 'sarcophagus_lid' }
        },
        hazards: { jackals: [0, 0], jars: [4, 6], traps: [1, 2], trapFillSeconds: 20, trapDelay: 0.8 },
        natives: [{ type: 'mummy', cost: 2, max: 4 }],
        palette: {
          wall: 0xa88c5c, moss: 0x2f5f96, paint2: 0x96382a, ceiling: 0x4a3c28, riser: 0x8a7048,
          kerb: 0xb89a64, turf: 0xc2a26a, fieldWall: 0x9a8258, ground: 0x8a7050,
          bone: 0xcfc6ad, wood: 0x5a4028, root: 0x4a3c28, clay: 0x8a5a3a, slab: 0xb09868,
          sky: 0x0e1426, fogOutside: 0x262430, fogInside: 0x000000,
          moon: 0xbcc8e0, ambient: 0x8a7a66
        },
        fog: { outside: 0.028, inside: 0.1 },
        moonStrength: 0.42
      },
      yomi: {
        name: 'Yomi Shrine',
        style: 'shrine', // a wooded hill in a bamboo grove, a red torii; paper walls, tatami, painted doors inside
        grid: { w: 48, h: 57 },
        interior: { x0: 6, y0: 14, x1: 42, y1: 53 },
        landing: { x: 24, y: 5 },
        rooms: { attempts: 130, max: 18, minSize: 3, maxSize: 6, extraLinks: 0.22, extraLinkRange: 16 },
        levels: { top: -0.1, perCell: -0.11, deepest: -3.2 },
        stepQuantum: 0.25,
        kerbHeight: 3.0,
        fieldWallHeight: 0.9,
        ceilings: { entrance: 2.8, chamber: 2.6, burial: 2.8, treasure: 3.2, corridor: 2.1, tunnel: 1.15 },
        surfaces: { entrance: 'stone', chamber: 'tatami', burial: 'tatami', treasure: 'wood', corridor: 'wood', tunnel: 'dirt' },
        outsideSurface: 'gravel',
        burialChance: 0.4, // "burial" rooms are shrine halls: tall wooden cabinets to hide behind, standing
        burialProp: 'cabinet',
        treasureProp: 'altar',
        entranceStyle: 'torii',
        outside: { boulders: 6, ringStones: 0, ringRadius: 5, bamboo: 40, stoneLanterns: 6 },
        loot: {
          perRoom: 0.15, perRoomDepth: 0.75,
          corridorItems: 3, chests: [1, 4], chestItems: [1, 2],
          slabGoods: 0.25,
          treasure: { plinth: 'bronze_mirror', floor: 'mikoshi' }
        },
        // paper: share of thin walls between passages that are paper screens (a lit goblin shows through);
        // nightingale: share of corridor cells with singing boards; lanterns: hanging paper lanterns,
        // obake: how many of them are awake and watching.
        hazards: { paper: 0.7, nightingale: 0.35, lanterns: [10, 16], obake: [2, 3] },
        natives: [{ type: 'onryo', cost: 2.5, max: 1, at: 'treasure' }, { type: 'gashadokuro', cost: 0, max: 1, outside: true, fromHour: 25 }, { type: 'bard', cost: 2, max: 1, fromHour: 24, crewOnly: true }],
        palette: {
          wall: 0xd8ccb0, moss: 0x7a2a20, paint2: 0x2a2018, ceiling: 0x2e2218, riser: 0x4a3424,
          kerb: 0x5a5a4e, turf: 0x3a4a2a, fieldWall: 0x6a6a5e, ground: 0x2e3a26,
          bone: 0xd8cfb4, wood: 0x4a3020, root: 0x3a2e22, clay: 0x6b4a33, slab: 0x5a4a3a,
          iron: 0x3a3a3a, paper: 0xe8dcc0, lacquer: 0x9a1e1a, lamp: 0xffb070, bamboo: 0x6a8a3a,
          sky: 0x10141e, fogOutside: 0x1a2020, fogInside: 0x000000,
          moon: 0xb0c0d8, ambient: 0x6a6a72
        },
        fog: { outside: 0.045, inside: 0.1 },
        moonStrength: 0.34
      },
      catacombs: {
        name: 'Drowned Catacombs',
        style: 'pit', // a sinkhole in a dead wood: down a switchback in the pit wall to a sunken cathedral's crypt
        grid: { w: 48, h: 58 },
        interior: { x0: 8, y0: 22, x1: 40, y1: 52 },
        landing: { x: 24, y: 5 },
        pit: { depth: 8, rimRow: 8, stepDown: 0.4 }, // rows past rimRow are the pit floor, depth meters down; the ramp drops stepDown a cell
        rooms: { attempts: 130, max: 18, minSize: 3, maxSize: 6, extraLinks: 0.22, extraLinkRange: 16 },
        levels: { top: -8.1, perCell: -0.1, deepest: -11.0 },
        stepQuantum: 0.25,
        kerbHeight: -1.5, // the cathedral's broken walls: 6.5 m above the pit floor, below the rim
        fieldWallHeight: 1.0, // the rim round the top of the pit
        ceilings: { entrance: 3.0, chamber: 2.8, burial: 3.2, treasure: 3.6, corridor: 2.2, tunnel: 1.15 },
        surfaces: { entrance: 'stone', chamber: 'stone', burial: 'stone', treasure: 'stone', corridor: 'stone', tunnel: 'dirt' },
        outsideSurface: 'dirt',
        burialChance: 0.45,
        entranceStyle: 'arch',
        outside: { boulders: 0, ringStones: 0, ringRadius: 5, deadTrees: 16, rubble: 20 },
        noOpenGround: true,
        // The flood: the sunken cathedral's bell tolls, and the water comes up a step. steps rises from low to
        // high, the first at firstHour, one every `every` hours, each taking riseHours; the bell warns warnHours ahead.
        tide: { low: -11.6, high: -7.4, steps: 5, firstHour: 20.5, every: 1.7, riseHours: 0.3, warnHours: 0.12, breathSeconds: 10, drownPerSecond: 9 },
        loot: {
          perRoom: 0.15, perRoomDepth: 0.75,
          corridorItems: 3, chests: [1, 4], chestItems: [1, 2],
          slabGoods: 0.3,
          treasure: { plinth: 'reliquary', floor: 'monstrance' }
        },
        natives: [{ type: 'hands', cost: 1.2, max: 5, fromHour: 20.6 }, { type: 'thief', cost: 1.5, max: 1 }, { type: 'bard', cost: 2, max: 1, fromHour: 24, crewOnly: true }],
        palette: {
          wall: 0x6a6a62, moss: 0x3a4a38, paint2: 0x2a2a28, ceiling: 0x2a2a28, riser: 0x4a4a44,
          kerb: 0x5a5a54, turf: 0x2e3228, fieldWall: 0x4a4a44, ground: 0x2a2a24,
          bone: 0xd8cfb4, wood: 0x3a3028, root: 0x2e2a24, clay: 0x5a4a3a, slab: 0x6a6a64,
          iron: 0x3a3a3a, water: 0x1a3a3a, lamp: 0xffb070,
          sky: 0x0a0c10, fogOutside: 0x0e1214, fogInside: 0x000000,
          moon: 0x98a8b8, ambient: 0x505860
        },
        fog: { outside: 0.06, inside: 0.1 },
        moonStrength: 0.14
      },
      terracotta: {
        name: 'Terracotta Mausoleum',
        style: 'cliff', // cut into a red cliff at the end of a narrow canyon; halls of clay soldiers inside
        grid: { w: 48, h: 63 },
        interior: { x0: 6, y0: 20, x1: 42, y1: 59 },
        landing: { x: 24, y: 5 },
        rooms: { attempts: 130, max: 18, minSize: 3, maxSize: 6, extraLinks: 0.22, extraLinkRange: 16 },
        levels: { top: -0.1, perCell: -0.1, deepest: -3.0 },
        stepQuantum: 0.25,
        kerbHeight: 14, // the cliff face above the door
        fieldWallHeight: 15, // the canyon walls (the renderer roughens them)
        ceilings: { entrance: 3.4, chamber: 3.0, burial: 3.6, treasure: 4.0, corridor: 2.3, tunnel: 1.15 },
        surfaces: { entrance: 'stone', chamber: 'stone', burial: 'dirt', treasure: 'stone', corridor: 'dirt', tunnel: 'dirt' },
        outsideSurface: 'gravel',
        burialChance: 0.5, // "burial" rooms are the statue halls: ranks of clay soldiers, standing cover
        burialProp: 'soldier_statue',
        entranceStyle: 'gate',
        outside: { boulders: 0, ringStones: 0, ringRadius: 5 },
        canyon: true, // everything outside is cliff but the landing, a canyon to the door and a cleft to the tunnel
        noOpenGround: true, // no room out there for the Knight or the Giant
        loot: {
          perRoom: 0.15, perRoomDepth: 0.75,
          corridorItems: 3, chests: [1, 4], chestItems: [1, 2],
          slabGoods: 0,
          treasure: { plinth: 'gold_seal', floor: 'jade_suit' }
        },
        natives: [{ type: 'soldier', cost: 2, max: 4 }, { type: 'bard', cost: 2, max: 1, fromHour: 24, crewOnly: true }],
        palette: {
          wall: 0x9a6a4a, moss: 0x5a3a28, paint2: 0x2a1a12, ceiling: 0x3a2618, riser: 0x5a3a26,
          kerb: 0x8a4a30, turf: 0x6a4a30, fieldWall: 0x8a4a30, ground: 0x5a3a26,
          bone: 0xd8cfb4, wood: 0x4a3020, root: 0x3a2e22, clay: 0xa05a38, slab: 0x6a5040,
          iron: 0x3a3a3a, paper: 0xe8dcc0, lacquer: 0x7a1a14, lamp: 0xffb070, bamboo: 0x6a8a3a,
          sky: 0x14101a, fogOutside: 0x2a1814, fogInside: 0x000000,
          moon: 0xd0b8a0, ambient: 0x6a5a58
        },
        fog: { outside: 0.03, inside: 0.1 },
        moonStrength: 0.34
      },
      mushroom: {
        name: 'Mushroom Warren',
        style: 'cave', // a hill of moss and giant fungus; rough caves inside, lit by glowcaps
        grid: { w: 48, h: 57 },
        interior: { x0: 6, y0: 14, x1: 42, y1: 53 },
        landing: { x: 24, y: 5 },
        rooms: { attempts: 130, max: 18, minSize: 3, maxSize: 6, extraLinks: 0.25, extraLinkRange: 16 },
        levels: { top: -0.2, perCell: -0.12, deepest: -3.4 },
        stepQuantum: 0.25,
        kerbHeight: 3.0,
        fieldWallHeight: 1.0,
        ceilings: { entrance: 3.0, chamber: 3.0, burial: 3.3, treasure: 3.4, corridor: 2.2, tunnel: 1.15 },
        surfaces: { entrance: 'dirt', chamber: 'loam', burial: 'loam', treasure: 'loam', corridor: 'dirt', tunnel: 'dirt' },
        outsideSurface: 'grass',
        burialChance: 0.4, // "burial" rooms are the fungus groves here: giant caps in rows
        burialProp: 'grove_cap',
        treasureProp: 'mother_bed',
        entranceStyle: 'cave',
        outside: { boulders: 10, ringStones: 0, ringRadius: 5, caps: 14 },
        loot: {
          perRoom: 0.15, perRoomDepth: 0.75,
          corridorItems: 3, chests: [1, 4], chestItems: [1, 2],
          slabGoods: 0.2,
          treasure: { plinth: 'spore_heart', floor: 'mother_cap' }
        },
        // glowcaps: clusters per room (they light you up, and pulse when stepped on);
        // puffballs: spore vents that puff a cloud every so often; clouds: how long they hang, how
        // wide, how long a lungful keeps you seeing things. Crouching holds your breath.
        hazards: { glowcaps: [1, 3], glowRange: 2.4, glowPulseLoud: 0.7, glowCooldown: 4,
          puffballs: [4, 7], puffEvery: [7, 14], cloudSeconds: 6, cloudRadius: 1.6, sporeSeconds: 25, caps: [1, 3] },
        natives: [{ type: 'myconid', cost: 2.5, max: 3 }],
        palette: {
          wall: 0x4a4250, moss: 0x3e5a44, ceiling: 0x2a2530, riser: 0x3e3844,
          kerb: 0x4a4650, turf: 0x2f4a30, fieldWall: 0x50504a, ground: 0x2a3a2a,
          bone: 0xcfc6ad, wood: 0x5a4028, root: 0x3a2e22, clay: 0x6b4a33, slab: 0x6a5a70,
          iron: 0x3a3a40, lamp: 0x5fffd0, cap: 0x8a4a6a, stalk: 0xd8cfc0,
          sky: 0x121626, fogOutside: 0x1a2228, fogInside: 0x000000,
          moon: 0xa8bcd4, ambient: 0x46465a
        },
        fog: { outside: 0.04, inside: 0.1 },
        moonStrength: 0.34,
        lampStrength: 0.42, lampReach: 4.5 // glowcaps: a faint teal glow close by; the caves stay dark
      },
      galleon: {
        name: 'Sunken Galleon',
        style: 'ship', // a wrecked galleon on its side on the sand: plank walls, beamed ceilings, broken masts
        grid: { w: 44, h: 57 },
        interior: { x0: 15, y0: 14, x1: 29, y1: 53 }, // the hull: 28 m across, 78 m from bow to stern
        landing: { x: 22, y: 5 },
        rooms: { attempts: 286, max: 18, minSize: 3, maxSize: 5, extraLinks: 0.2, extraLinkRange: 14 },
        levels: { top: -0.1, perCell: -0.1, deepest: -2.2 }, // a wreck is shallower than a tomb
        stepQuantum: 0.25,
        kerbHeight: 3.0,
        fieldWallHeight: 0.8,
        ceilings: { entrance: 2.7, chamber: 2.5, burial: 2.7, treasure: 2.9, corridor: 2.1, tunnel: 1.15 },
        surfaces: { entrance: 'deck', chamber: 'deck', burial: 'deck', treasure: 'deck', corridor: 'deck', tunnel: 'deck' },
        outsideSurface: 'sand',
        burialChance: 0.45, // "burial" rooms are the cargo holds here
        burialProp: 'cargo',
        treasureProp: 'desk',
        entranceStyle: 'breach',
        coverPerRoom: 2,    // holds full of crates and barrels
        outside: { boulders: 16, ringStones: 0, ringRadius: 5, masts: 3, driftwood: 10 },
        loot: {
          perRoom: 0.2, perRoomDepth: 0.8,
          corridorItems: 3, chests: [2, 5], chestItems: [1, 2],
          slabGoods: 0.25,
          treasure: { plinth: 'jewelled_compass', floor: 'treasure_chest' }
        },
        // The tide: the sea level inside the wreck through the night (meters), rising from low
        // at dusk to high at dawn, faster after midnight. Loot lying under water is lost;
        // a goblin's head under water loses its lantern, then its breath.
        tide: { low: -2.8, high: -0.55, curve: 1.3, breathSeconds: 10, drownPerSecond: 9 },
        natives: [{ type: 'captain', cost: 2.5, max: 1, at: 'treasure' }, { type: 'crabs', cost: 1, max: 4 }],
        palette: {
          wall: 0x4e3a28, moss: 0x3a4a3a, ceiling: 0x2e2218, riser: 0x3e2e20,
          kerb: 0x3a2c20, turf: 0x4a3a2a, fieldWall: 0x5a5650, ground: 0x8a7858,
          bone: 0xd8cfb4, wood: 0x6a4e32, root: 0x2e2218, clay: 0x6b4a33, slab: 0x5a4632,
          iron: 0x4a3a30, water: 0x1f4a52,
          sky: 0x0f1822, fogOutside: 0x1c2630, fogInside: 0x000000,
          moon: 0xaec0d8, ambient: 0x6a7078
        },
        fog: { outside: 0.03, inside: 0.1 },
        moonStrength: 0.4
      },
      ossuary: {
        name: 'Dwarf Ossuary',
        style: 'mine', // a mountainside, a timbered adit, rails, rope bridges, bone walls, dwarven lamps
        grid: { w: 48, h: 57 },
        interior: { x0: 6, y0: 14, x1: 42, y1: 53 },
        landing: { x: 24, y: 5 },
        rooms: { attempts: 117, max: 18, minSize: 3, maxSize: 6, extraLinks: 0.2, extraLinkRange: 16 },
        levels: { top: -0.2, perCell: -0.14, deepest: -3.8 },
        stepQuantum: 0.25,
        kerbHeight: 3.0,
        fieldWallHeight: 1.6,
        ceilings: { entrance: 3.0, chamber: 2.8, burial: 3.0, treasure: 3.4, corridor: 2.2, tunnel: 1.15, chasm: 3.6 },
        surfaces: { entrance: 'basalt', chamber: 'basalt', burial: 'gravel', treasure: 'basalt', corridor: 'dirt', tunnel: 'dirt', chasm: 'planks' },
        outsideSurface: 'scree',
        burialChance: 0.4,
        burialProp: 'dwarf_tomb',
        entranceStyle: 'adit',
        outside: { boulders: 22, ringStones: 0, ringRadius: 5, pines: 18 },
        loot: {
          perRoom: 0.15, perRoomDepth: 0.75,
          corridorItems: 3, chests: [2, 4], chestItems: [1, 2],
          slabGoods: 0.3,
          treasure: { plinth: 'deep_crown', floor: 'dwarven_anvil' }
        },
        // chasms: rooms crossed by a rope bridge; drop: how far down the dark goes.
        // caveins: weak ceilings in corridors that come down when there's enough noise underneath.
        // carts: a rail from the entrance hall deep into the mine.
        hazards: { chasms: [1, 2], chasmDrop: 7, bridgeWidth: 1.1,
          caveins: [3, 5], caveinStrain: 1.0, caveinDecay: 0.6, caveinRange: 3.5, caveinDelay: 1.1, caveinHit: 65, rubble: 0.4,
          carts: 1, cartMinCells: 10, cartSpeed: 3.2, cartHit: 40, cartRumbleEvery: 0.4, cartLoud: 1.0,
          lamps: 0.45 },
        // halls: carved pillars in the big halls, guardian statues by doorways, a smouldering forge.
        halls: { statues: [2, 4], forges: [1, 2] },
        natives: [],
        palette: {
          band: 0x9a7038, ore: 0xc8883a, gem: 0x4aa0b8,
          wall: 0x3c3b40, moss: 0x6a4a2e, ceiling: 0x232226, riser: 0x44424a,
          kerb: 0x4a4850, turf: 0x3f403d, fieldWall: 0x46444a, ground: 0x303234,
          bone: 0xd8cfb4, wood: 0x5a4028, root: 0x3a2a1c, clay: 0x6b4a33, slab: 0x5e5c62,
          iron: 0x6a3e26, lamp: 0xff9a3c,
          sky: 0x10151f, fogOutside: 0x1a1d24, fogInside: 0x000000,
          moon: 0xa9b6cc, ambient: 0x6e6a70
        },
        fog: { outside: 0.035, inside: 0.1 },
        moonStrength: 0.36
      },
      barrow: {
        name: 'Barrow Mounds',
        grid: { w: 48, h: 57 },
        interior: { x0: 6, y0: 14, x1: 42, y1: 53 }, // the mound, in cells
        landing: { x: 24, y: 5 },
        rooms: { attempts: 117, max: 17, minSize: 3, maxSize: 6, extraLinks: 0.18, extraLinkRange: 16 },
        // Floors sink deeper the farther you walk from the entrance.
        levels: { top: -0.1, perCell: -0.12, deepest: -3.4 },
        stepQuantum: 0.25,  // corridor floors snap to stair steps of this height
        kerbHeight: 3.0,    // top of the mound\'s stone kerb
        fieldWallHeight: 1.3,
        ceilings: { entrance: 2.8, chamber: 2.6, burial: 3.0, treasure: 3.2, corridor: 2.0, tunnel: 1.15 },
        surfaces: { entrance: 'stone', chamber: 'dirt', burial: 'gravel', treasure: 'stone', corridor: 'dirt', tunnel: 'dirt' },
        burialChance: 0.4,  // rooms that are neither entrance nor treasure: burial hall or chamber
        natives: [],        // the Barrow-Wight comes later
        outside: { boulders: 14, ringStones: 7, ringRadius: 5 },
        loot: {
          perRoom: 0.15, perRoomDepth: 0.75, // items per room = perRoom + depth * perRoomDepth
          corridorItems: 3, chests: [2, 4], chestItems: [1, 2],
          slabGoods: 0.25,                 // chance a burial slab carries grave goods
          treasure: { plinth: 'gold_arm_ring', floor: 'hoard_urn' }
        },
        palette: {
          wall: 0x5b5f55, moss: 0x48593a, ceiling: 0x322f28, riser: 0x5a584e,
          kerb: 0x74786e, turf: 0x3b4930, fieldWall: 0x66685f, ground: 0x36422f,
          bone: 0xcfc6ad, wood: 0x5a4028, root: 0x3a2e22, clay: 0x6b4a33, slab: 0x7c7e74,
          sky: 0x141b26, fogOutside: 0x1a222d, fogInside: 0x000000,
          moon: 0x9fb2cc, ambient: 0x6b7a66
        },
        fog: { outside: 0.045, inside: 0.1 },
        moonStrength: 0.32
      }
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = GOB;
})(typeof window !== 'undefined' ? window : globalThis);
