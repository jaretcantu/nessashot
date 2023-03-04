/* nessashot.js
 * Pokemon UNITE build simulator and comparer
 * https://github.com/jaretcantu/nessashot
 * Copyright (C) 2021-2023 Jaret Jay Cantu
 * Licensed under the AGPL
 */

// convenience functions
function isArray(obj) { return (obj && obj.constructor == Array); }
function isDefined(obj) { return typeof(obj) != 'undefined'; }
Array.prototype.contains = function(e) {
	for (var i=0; i<this.length; i++)
		if (e == this[i])
			return true;
	return false;
}


// server constants
var TICKS_PER_SECOND = 15;

// constants (that don't have a class to be shoved in)
var HINT_CRIT	= 0x00000001;
var HINT_SCORE	= 0x00000002;
var HINT_PHYS	= 0x00000004;
var HINT_SPEC	= 0x00000008;

// non-class mathematic functions
function damageReduction(d) {
	return 600.0 / (600 + d);
}

function calcEffectiveHP(hp, def) {
	return Math.floor(hp / damageReduction(def));
}

// Classes

function Stats(args) {
	if (arguments.length == 0) {
		for (var s=0; s<Stats.LIST.length; s++)
			this[Stats.LIST[s]] = 0;
	} else if (arguments.length == 2) {
		// Assume this is a name-value pair; this function exists to
		// make it easier to use a variable to specify a stat
		Stats.call(this);
		this[arguments[0]] = arguments[1];
	} else if (arguments.length > 1) {
		// Re-invoke as array syntax
		Stats.call(this, arguments);
	} else if (isDefined(args.length)) {
		Stats.call(this); // make sure everything is at least zero'd
		// Array or argument list
		for (var s=0; s<args.length; s++)
			this[Stats.LIST[s]] = args[s];
		// XXX Define defaults for Pokemon, which aren't known or
		//     known to be different as of yet.
		this.critdamage = 1; // additional damage when crit
		this.charge = 1; // there is some per-pokemon rate
		this.movement = 600; /* just to show changes with items, which
				      * are quite large for FloatStone, so go
				      * with the Defense formula "average" */
	} else { // Assume object/associative array
		Stats.call(this);
		// Transfer all elements from arguments to stats object
		for (var k in args)
			this[k] = args[k];
	}
}
Stats.LIST = ["health", "attack", "defense", "spattack", "spdefense",
		"critrate", "aps", "cdr", "lifesteal",
		// Known values, but aren't in the json
		"spellvamp", "tenacity",
		// Stats that are probably in progression but unknown currently
		"charge", "movement",
		// Stats that are probably outside of progression and item only
		"critdamage", "recovery"];
Stats.BASIC_STATS = ["health", "attack", "defense", "spattack", "spdefense",
			"movement"];
Stats.prototype.toString = function() {
	var str = "Stats(";
	var something = false;
	for (var i=0; i<Stats.LIST.length; i++) {
		var s = Stats.LIST[i];
		if (this[s] != 0) {
			if (something)
				str+= ", ";
			str+= s + "=" + this[s];
			something = true;
		}
	}
	return str + ")";
}
Stats.prototype.add = function(addend) {
	for (var i=0; i<Stats.LIST.length; i++) {
		var s = Stats.LIST[i];
		this[s]+= addend[s];
	}
}

function Passive(proc, func) {
	if (arguments.length == 0) return;
	this.condition = proc;
	this.func = func;
}
Passive.DUMMY = new Passive(0, null); // never procs
Passive.INIT	= 0x0001;
Passive.BASIC	= 0x0002;
Passive.COOLDOWN =0x0004;
Passive.MOVE	= 0x0006;
Passive.CRIT	= 0x0008;
Passive.prototype.checkCondition = function(type, poke, item, foe) {
	return (type & this.condition);
}
Passive.prototype.proc = function(type, poke, item, foe) {
	if (this.checkCondition(type, poke, item, foe))
		this.func(poke, item, foe);
}
Passive.prototype.calc = function(pkmn) {
	return 0;
}
Passive.prototype.cooldown = function(pkmn) {
	return 1; // prevent divide-by-zero error for DPS calculation
}

function StatPassive(proc, statf) {
	if (arguments.length == 0) return;
	Passive.call(this, proc, StatPassive.addStats);
	this.statFunc = statf;
}
StatPassive.prototype = new Passive();
StatPassive.prototype.constructor = StatPassive;
StatPassive.addStats = function(poke, item, foe) {
	poke.stats.add(this.statFunc(poke, item, foe));
}

function ScoreScalingPassive(stat) {
	StatPassive.call(this, Passive.INIT, this.multiplier);
	this.stat = stat;
}
ScoreScalingPassive.prototype = new StatPassive();
ScoreScalingPassive.prototype.constructor = ScoreScalingPassive;
ScoreScalingPassive.prototype.multiplier = function(poke, item, foe) {
	return new Stats(this.stat, item.unlock * poke.scores);
}

function PercentItemPassive(stat) {
	/* XXX This may have to be either a LATE_INIT or EARLY_INIT */
	StatPassive.call(this, Passive.INIT, this.multiplier);
	this.stat = stat;
}
PercentItemPassive.prototype = new StatPassive();
PercentItemPassive.prototype.constructor = PercentItemPassive;
PercentItemPassive.prototype.multiplier = function(poke, item, foe) {
	/* Add the base Pokemon's stat at a given level */
	return new Stats(this.stat, item.unlock *
			  poke.pokemon.progression[poke.level-1][this.stat]);
}

function TimedItemPassive(cond, func, time) {
	Passive.call(this, Passive.INIT, this.multiplier);
	this.time = time;
}
TimedItemPassive.prototype = new Passive();
TimedItemPassive.prototype.constructor = TimedItemPassive;
TimedItemPassive.prototype.checkCondition = function(cond, pkmn, item, foe) {
	if (this.time == 0) // XXX Check against ItemState.cooldown
		return false;
	// Run standard condition check
	if (!Passive.call(Passive.prototype.checkCondition,
			  cond, pkmn, item, foe))
		return false;
	// Reset timer now that the parent condition has been satisfied
	// XXX TODO Reset timer here
	return true;
}
TimedItemPassive.prototype.cooldown = function(pkmn) { return this.time; }

function MoveItemPassive(cond) {
	TimedItemPassive.call(this, cond, MoveItemPassive.useMove, 0);
}
MoveItemPassive.prototype = new TimedItemPassive();
MoveItemPassive.prototype.constructor = MoveItemPassive;
MoveItemPassive.useMove = function(pkmn, item, foe) {
	// Execute a move-like effect
	// XXX TODO Determine if movelike is offensive or defensive
}
MoveItemPassive.prototype.getItemState = function(pkmn) {
	for (var i=0; i<pkmn.items.length; i++) {
		var is = pkmn.items[i];
		if (is.item.passive == this)
			return is;
	}
	throw("Could not find item state for " + this);
}
MoveItemPassive.prototype.getMove = function(pkmn) {
	// Normally, the item state is passed in through proc()
	return this.getItemState(pkmn).unlock;
}
MoveItemPassive.prototype.calc = function(pkmn) {
	return this.getMove(pkmn).calc(pkmn);
}
MoveItemPassive.prototype.cooldown = function(pkmn) {
	return this.getMove(pkmn).getCoolDown(pkmn);
}

function BasicMoveItemPassive() {
	MoveItemPassive.call(this, Passive.BASIC);
}
BasicMoveItemPassive.prototype = new MoveItemPassive();
BasicMoveItemPassive.prototype.constructor = BasicMoveItemPassive;
BasicMoveItemPassive.prototype.calc = function(pkmn) {
	return this.getMove(pkmn).calc(pkmn);
}
BasicMoveItemPassive.prototype.checkCondition = function(cond, pkmn, item, foe){
	// Requires a cooldown to set up and a basic to proc
	if (cond & Passive.INIT) {
		item.cooldown = -1; // Set off until a cooldown is used
	} else if (item.cooldown >= 0 && (cond & Passive.COOLDOWN)) {
		item.cooldown = 0;
	} else {
		return MoveItemPassive.prototype.checkCondition(cond, pkmn,
								item, foe);
	}
	return false;
}

function BoostedProc() {
}
BoostedProc.prototype.set = function(poke) { }
BoostedProc.prototype.check = function(poke) { return false; }
BoostedProc.prototype.reset = function(poke) {
	// This should be a fairly common reset
	poke.boostedCounter = 0;
}
BoostedProc.prototype.basicsPerBoosted = function(poke) {
	return 0; // dummy value
}
BoostedProc.prototype.getASBonus = function(poke) { return 0; }

function UsageBoostedProc(times) {
	this.times = times;
}
UsageBoostedProc.prototype = new BoostedProc();
UsageBoostedProc.prototype.constructor = UsageBoostedProc;
UsageBoostedProc.prototype.set = function(poke) {
	poke.boostedCounter = this.times;
}
UsageBoostedProc.prototype.check = function(poke) {
	if (poke.boostedCounter == this.times-1) {
		poke.boostedCounter = 0;
		return true;
	}
	poke.boostedCounter++;
	return false;
}
UsageBoostedProc.prototype.basicsPerBoosted = function(poke) {
	return this.times;
}

function TimedBoostedProc(time) {
	this.time = time;
}
TimedBoostedProc.prototype = new BoostedProc();
TimedBoostedProc.prototype.constructor = TimedBoostedProc;
TimedBoostedProc.prototype.set = function(poke) {
	poke.boostedCounter = this.time * TICKS_PER_SECOND;
}
TimedBoostedProc.prototype.check = function(poke) {
	if (poke.boostedCounter >= this.time) {
		poke.boostedCounter = 0;
		return true;
	}
	/* If user is spamming attacks, and this check is performed after
	 * every attack, then (this.time/APS) is how long it takes for a
	 * new boosted attack to be readied.
	 */
	poke.boostedCounter+= poke.ticksPerBasic();
	return false;
}
TimedBoostedProc.prototype.basicsPerBoosted = function(poke) {
	return Math.ceil(this.time/poke.ticksPerBasic());
}

function RampBoostedProc(times, asBonus, maxFlat, maxLev) {
	UsageBoostedProc.call(this, times);
	this.attackSpeedBonus = asBonus;
	this.maxAttackSpeedBonusFlat = maxFlat;
	this.maxAttackSpeedBonusLvl = maxLev;
}
RampBoostedProc.prototype = new UsageBoostedProc();
RampBoostedProc.prototype.constructor = RampBoostedProc;
RampBoostedProc.prototype.reset = function(poke) {
	/* No-op; reset will only happen when the attacks are dropped, which
	 * we will assume will never happen.
	 */
}
RampBoostedProc.prototype.check = function(poke) {
	// Don't ramp the boosted counter past the max times
	if (poke.boostedCounter == this.times)
		return true;
	if (++poke.boostedCounter == this.times)
		return true;
	return false;
}
RampBoostedProc.prototype.basicsPerBoosted = function(poke) {
	return this.times;
}
RampBoostedProc.prototype.getASBonus = function(poke) {
	// If we are at max times, return the max (for non-gradual increases)
	var max = this.maxAttackSpeedBonusFlat +
		  this.maxAttackSpeedBonusLvl * (poke.level-1);
	if (poke.boostedCounter == this.times)
		return max;
	// Calculate per-hit
	var bonus = poke.boostedCounter * this.attackSpeedBonus;
	return bonus < max ? bonus : max;
}

BoostedProc.EVERY_3RD = new UsageBoostedProc(3);
BoostedProc.EVERY_4TH = new UsageBoostedProc(4);
BoostedProc.FIVE_SECONDS = new TimedBoostedProc(5);

function Move(name, cd) {
	if (arguments.length == 0) return;
	this.name = name;
	this.cooldown = cd;
	// Values not common enough to justify an argument
	this.storedUses = 1;
	this.resetsBoosted = false;
	this.lockout = 0;
	this.cdx = 0;
}
Move.prototype.toString = function() {
	return "Move(" + this.name + ")";
}
Move.prototype.getCoolDown = function(pkmn) {
	var cdr = 1.0 - pkmn.stats.cdr;
	return this.cooldown*cdr + this.cdx;
}
Move.prototype.setStore = function(u) {
	this.storedUses = u;
	return this;
}
Move.prototype.setLockOut = function(lo) {
	this.lockout = lo;
	return this;
}
Move.prototype.setCoolDownEx = function(cdx) {
	this.cdx = cdx;
	return this;
}
Move.prototype.setBoost = function() {
	this.resetsBoosted = true;
	return this;
}
Move.prototype.calc = function(pkmn) {
	return 0;
}
Move.prototype.canCrit = function() {
	return false;
}

function ComboMove(name, cd, moves) {
	if (arguments.length == 0) return;
	Move.call(this, name, cd);
	if (!isArray(moves)) {
		/* Instead of an array, we have received a times X move string
		 * argument list, so reformulate this into an array. */
		var count = moves;
		moves = new Array(count);
		for (var m=0; m<count; m++)
			moves[m] = arguments[3];
	}
	this.moves = moves;
}
ComboMove.prototype = new Move();
ComboMove.prototype.constructor = ComboMove;
ComboMove.prototype.calc = function(pkmn) {
	var total = 0;
	for (var m=0; m<this.moves.length; m++) {
		try {
		total+= pkmn.pokemon.moveset[this.moves[m]].calc(pkmn);
		} catch(e) { throw(this + ".calc() failed on " +
					this.moves[m] + ": " + e);
		}
	}
	return total;
}

function StatusMove(name, dur, flatStats, lvlStats, cd) {
	if (arguments.length == 0) return;
	Move.call(this, name, cd);
	this.duration = dur;
	this.flatStats = flatStats;
	this.lvlStats = lvlStats;
}
StatusMove.prototype = new Move();
StatusMove.prototype.constructor = StatusMove;

function BuffMove(name, dur, flatStats, lvlStats, cd) {
	if (arguments.length == 0) return;
	StatusMove.apply(this, arguments);
}
BuffMove.prototype = new StatusMove();
BuffMove.prototype.constructor = BuffMove;

function DebuffMove(name, dur, flatStats, lvlStats, cd) {
	if (arguments.length == 0) return;
	StatusMove.apply(this, arguments);
}
DebuffMove.prototype = new StatusMove();
DebuffMove.prototype.constructor = DebuffMove;

function HealthModMove(name, pmux, smux, lev, flat, cd) {
	if (arguments.length == 0) return;
	Move.call(this, name, cd);
	this.physMultiplier = pmux;
	this.specMultiplier = smux;
	this.levelScaling = lev;
	this.baseDamage = flat;
	this.maxHealth = 0;
	this.remHealth = 0;
}
HealthModMove.prototype = new Move();
HealthModMove.prototype.constructor = HealthModMove;
HealthModMove.prototype.setPerc = function(rh, mh) {
	this.remHealth = rh;
	this.maxHealth = mh;
	return this;
}
HealthModMove.prototype.calc = function(pkmn) {
	return	this.physMultiplier * pkmn.stats.attack +
		this.specMultiplier * pkmn.stats.spattack +
		this.levelScaling * (pkmn.level-1) +
		this.baseDamage;
}

function DamagingMove(name, pmux, smux, lev, flat, cd) {
	if (arguments.length == 0) return;
	HealthModMove.apply(this, arguments);
	this.crittable = false;
}
DamagingMove.prototype = new HealthModMove();
DamagingMove.prototype.constructor = DamagingMove;
DamagingMove.prototype.setCrit = function() {
	this.crittable = 1;
	return this;
}
DamagingMove.prototype.canCrit = function() { return this.crittable; }

function HealingMove(name, pmux, smux, lev, flat, cd) {
	if (arguments.length == 0) return;
	HealthModMove.apply(this, arguments);
}
HealingMove.prototype = new HealthModMove();
HealingMove.prototype.constructor = HealingMove;

Move.BASIC = new DamagingMove("Basic", 1, 0, 0, 0, 0).setCrit();
Move.CRITLESS_BASIC = new DamagingMove("Basic", 1, 0, 0, 0, 0);

function Item(name, prog, unlocks, passive) {
	if (arguments.length == 0) return;
	if (prog.length != 30) {
		throw("Item " + name + " has " + prog.length +
			" level progress instead of 30");
	}
	if (unlocks.length != 3) {
		throw("Item " + name + " has " + unlocks.length +
			" unlocks instead of 3");
	}
	this.name = name;
	this.progression = prog;
	this.unlocks = unlocks;
	this.hints = 0;
	this.passive = passive;
	// Just check the highest level for any crit modification
	if (this.progression[this.progression.length-1].critrate)
		this.hints|= HINT_CRIT;
	if (this.passive != null &&
	    this.passive.constructor == ScoreScalingPassive)
		this.hints|= HINT_SCORE;
}
Item.prototype.calc = function(pkmn) {
	if (this.passive)
		return this.passive.calc(pkmn);
	return 0;
}
Item.prototype.cooldown = function(pkmn) {
	if (this.passive)
		return this.passive.cooldown(pkmn);
	return 1; // prevent DPS calculations from having divide-by-zero error
}

function EmblemColor(stat, r1, b1, r2, b2, r3, b3) {
	this.stat = stat;
	this.requirement = [r1, r2, r3];
	this.bonus = [b1, b2, b3];
}
EmblemColor.prototype.getBonus = function(count) {
	for (var i=this.bonus.length-1; i>=0; i--) {
		if (count >= this.requirement[i])
			return this.bonus[i];
	}
	return 0;
}

function Emblem(family, color, grade, bonus, penalty) {
	this.family = family;
	this.color = color;
	this.grade = Emblem.GRADES[grade];
	this.bonus = bonus;
	this.penalty = penalty;
}
Emblem.GRADES = {Bronze:0, Silver:1, Gold:2};
Emblem.RGRADES = ["Bronze", "Silver", "Gold"];
Emblem.STATS = [ new Stats(30, 1.2, 3, 1.8, 3, 0.003, 0,0,0,0,0,0, 21),
		 new Stats(40, 1.6, 4, 2.4, 4, 0.005, 0,0,0,0,0,0, 28),
		 new Stats(50, 2,   5, 3,   5, 0.006, 0,0,0,0,0,0, 35) ];
Emblem.COLORS = {
		Black: new EmblemColor('cdr', 3, 0.01, 5, 0.02, 7, 0.04),
		Blue: new EmblemColor('defense', 2, 0.02, 4, 0.04, 6, 0.08),
		Brown: new EmblemColor('attack', 2, 0.01, 4, 0.02, 6, 0.04),
		Green: new EmblemColor('spattack', 2, 0.01, 4, 0.02, 6, 0.04),
		Navy: new EmblemColor('charge', 3, 0.01, 5, 0.02, 7, 0.04),
		Pink: new EmblemColor('tenacity', 3, 0.04, 5, 0.08, 7, 0.16),
		Purple: new EmblemColor('spdefense', 2, 0.02, 4, 0.04, 6, 0.08),
		Red: new EmblemColor('aps', 3, 2, 5, 4, 7, 8),
		White: new EmblemColor('health', 2, 0.01, 4, 0.02, 6, 0.04),
		Yellow: new EmblemColor('movement', 3, 0.04, 5, 0.06, 7, 0.12),
	};
Emblem.prototype.toString = function() {
	return Emblem.RGRADES[this.grade] + this.family;
}

function EmblemPage(args) {
	if (isDefined(args.length)) { // is array (or arguments)
		this.name = '';
		this.colors = {};
		this.stats = new Stats();
		var dupes = [];
		for (var i=0; i<args.length; i++) {
			var a = args[i];
			// Check if the name of an emblem was provided
			if (isDefined(Emblem.LIST[a]))
				a = Emblem.LIST[a];
			if (a instanceof Emblem) {
				if (this.name != '') this.name+= '/';
				this.name+= a;
				if (!dupes.contains(a.family)) {
					dupes.push(a.family);
					for (var c=0; c<a.color.length; c++) {
						var cl = a.color[c];
						if (!isDefined(this.colors[cl]))
							this.colors[cl] = 0;
						this.colors[cl]++;
					}
				}
				if (a.bonus)
					this.stats[a.bonus]+=
						Emblem.STATS[a.grade][a.bonus];
				if (a.penalty)
					this.stats[a.penalty]-=
						Emblem.STATS[a.grade][a.penalty];
			} else if (a.indexOf('=') >= 0) {
				// For text input
				var pair = a.split('=');
				var col = pair[0].charAt(0).toUpperCase() +
					  pair[0].substring(1).toLowerCase();
				if (isDefined(Emblem.COLORS[col])) {
					if (!isDefined(this.colors[col]))
						this.colors[col] = 0;
					this.colors[col]+= Number(pair[1]);
				} else if (pair[1].endsWith('%')) {
					if (!isDefined(this.stats.percs))
						this.stats.percs = [];
					var p0 = pair[0];
					if (!isDefined(this.stats.percs[p0]))
						this.stats.percs[p0] = 0;
					var p = Number(pair[1].substring(0,
							pair[1].length-1))/100;
					this.stats.percs[p0]+= p;
				} else {
					this.stats[pair[0]]+= Number(pair[1]);
				}
			}
		}
	} else {
		EmblemPage.call(this, arguments); // treat arg list as array
	}
}
EmblemPage.prototype.toString = function() {
	return this.name;
}
EmblemPage.prototype.addStats = function(poke) {
	var baseStats = poke.pokemon.progression[poke.level-1];
	for (var c in this.colors) {
		var col = Emblem.COLORS[c];
		var bns = col.getBonus(this.colors[c]);
		if (Stats.BASIC_STATS.contains(col.stat))
			poke.stats[col.stat]+= baseStats[col.stat] * bns;
		else
			poke.stats[col.stat]+= bns;
	}
	if (this.stats.percs) {
		for (c in this.stats.percs) {
			var bns = this.stats.percs[c];
			poke.stats[c]+= baseStats[c] * bns;
		}
	}
	for (var i=0; i<Stats.LIST.length; i++) {
		var s = Stats.LIST[i];
		// emblem stats are rounded up, apparently
		if (Stats.BASIC_STATS.contains(s))
			poke.stats[s]+= Math.round(this.stats[s]);
		else
			poke.stats[s]+= this.stats[s];
	}
}

function LearnSet(level, upgrade, moves) {
	this.level = level;
	this.upgrade = upgrade;
	this.moves = moves;
}

function Pokemon(name, type, range, role, prog, moveset, bacond,
		 learnat1, upgrade1, learnset1, learnat2, upgrade2, learnset2,
		 uniteat, unite, passive) {
	if (arguments.length == 0) return;
	if (prog.length != 15) {
		throw("Pokemon " + name + " has " + prog.length +
			" level progress instead of 15");
	}
	this.name = name;
	this.type = type;
	this.range = range;
	this.role = role
	this.progression = prog;
	this.boostedProc = bacond;
	this.moveset = moveset;
	this.learnset = [
			new LearnSet(learnat1, upgrade1, learnset1),
			new LearnSet(learnat2, upgrade2, learnset2),
			new LearnSet(uniteat, 0, [null, unite]),
		];
	this.passive = passive;
	this.hints = 0;
	if (this.progression[this.progression.length-1].critrate)
		this.hints|= HINT_CRIT;
	if (this.type == Pokemon.PHYSICAL)
		this.hints|= HINT_PHYS;
	// normalize learnsets
	for (var l=0; l<this.learnset.length; l++) {
		var ls = this.learnset[l];
		for (var m=0; m<ls.moves.length; m++) {
			// A null entry means the same as the previous entry
			if (m>0 && ls.moves[m] === null)
				ls.moves[m] = ls.moves[m-1];
			// Expand string key references to object references
			if (typeof(ls.moves[m]) === "string")
				ls.moves[m] = this.moveset[ls.moves[m]];
		}
	}
}
Pokemon.MELEE = 0;
Pokemon.RANGED = 1;
Pokemon.PHYSICAL = 0;
Pokemon.SPECIAL = 1;
Pokemon.ALLROUNDER = 0;
Pokemon.ATTACKER = 1;
Pokemon.DEFENDER = 2;
Pokemon.SPEEDSTER = 3;
Pokemon.SUPPORTER = 4;

// state classes

function ItemState(item, level) {
	this.item = typeof(item) === 'string' ? Item.LIST[item] : item;
	this.level = level;
	this.cooldown = 0;
	// Set derived values for simplicity
	this.unlock = this.item.unlocks[this.level > 20 ? 2 :
					this.level > 10 ? 1 : 0];
}
ItemState.prototype.addStats = function(stats) {
	stats.add(this.item.progression[this.level-1]);
}

function Champion(poke, level, item1, ilev1, item2, ilev2, item3, ilev3,
		  moveFirst, move1, move2, score, emblems) {
	this.pokemon = typeof(poke) === 'string' ? Pokemon.LIST[poke] : poke;
	this.level = level;
	this.stats = new Stats(this.pokemon.progression[this.level-1]);
	this.scores = score;
	this.emblems = emblems;
	this.boostedCounter = 0;
	this.moves = [];
	if (this.level < 3) {
		this.moves.push(this.pokemon.learnset[moveFirst].moves[0]);
	} else {
		for (var m=0; m<2; m++) {
			var ls = this.pokemon.learnset[m];
			var moveMod = (m==0 ? move1 : move2) * 2;
			if (this.level >= ls.upgrade)
				this.moves.push(ls.moves[2+moveMod]);
			else if (this.level >= ls.level)
				this.moves.push(ls.moves[1+moveMod]);
			else
				this.moves.push(ls.moves[0]);
		}
	}
	// Don't bother sorting items here; sort them when running longterm sims
	this.items = [	new ItemState(item1, ilev1),
			new ItemState(item2, ilev2),
			new ItemState(item3, ilev3) ];
	// Create easy hints reference so we don't have to recurse every access
	this.hints = this.pokemon.hints;
	if (this.emblems)
		this.emblems.addStats(this);
	for (var i=0; i<this.items.length; i++) {
		this.hints|= this.items[i].item.hints;
		this.items[i].addStats(this.stats);
	}
	// int all stats
	for (i=0; i<Stats.BASIC_STATS.length; i++) {
		var s = Stats.BASIC_STATS[i];
		this.stats[s] = Math.floor(this.stats[s]);
	}
}
Champion.prototype.init = function() {
	this.procPassives(Passive.INIT);
	this.maxhealth = this.stats.health;
}
Champion.prototype.procPassives = function(type, foe) {
	if (arguments.length < 2)
		foe = null;
	this.pokemon.passive.proc(type, this, null, foe);
	for (var i=0; i<this.items.length; i++) {
		var itm = this.items[i];
		if (!itm.item) continue;
		itm.item.passive.proc(type, this, itm, foe);
	}
}
Champion.prototype.basicsPerBoosted = function() {
	return this.pokemon.boostedProc.basicsPerBoosted(this);
}
Champion.ticksPerAttackSpeed = function(aps) {
	/* Ticks per attack = T/c where T is the period of an attack (in
 	 * milliseconds) and c is the constant server tick time (in
 	 * milliseconds)
	 */
	return Math.ceil(Math.floor(100000/(100+aps))/66);
}
Champion.prototype.ticksPerBasic = function() {
	return Champion.ticksPerAttackSpeed(this.stats.aps);
}
Champion.prototype.ticksPerBoosted = function() {
	return Champion.ticksPerAttackSpeed(this.stats.aps +
		this.pokemon.boostedProc.getASBonus(this));
}
