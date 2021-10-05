/* nessashot.js
 * Pokemon UNITE build simulator and comparer
 * Copyright (C) 2021 Jaret Jay Cantu
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


// constants (that don't have a class to be shoved in)
var HINT_CRIT	= 0x00000001;
var HINT_SCORE	= 0x00000002;
var HINT_PHYS	= 0x00000004;

// non-class mathematic functions
function damageReduction(d) {
	return 600 / (600 + d);
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
		// Stats that are probably in progression but unknown currently
		"charge", "movement",
		// Stats that are probably outside of progression and item only
		"critdamage", "recovery"];
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
Passive.INIT = 1;
Passive.prototype.proc = function(type, poke, item, foe) {
	if (type == this.condition)
		this.func(poke, item, foe);
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

function BoostedProc() {
}
BoostedProc.prototype.set = function(poke) { }
BoostedProc.prototype.check = function(poke) { return false; }
BoostedProc.prototype.reset = function(poke) {
	// This should be a fairly common reset
	poke.boostedCounter = 0;
}

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

function TimedBoostedProc(time) {
	this.time = time;
}
TimedBoostedProc.prototype = new BoostedProc();
TimedBoostedProc.prototype.constructor = TimedBoostedProc;
TimedBoostedProc.prototype.set = function(poke) {
	poke.boostedCounter = this.time;
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
	poke.boostedCounter+= 1/poke.stats.aps;
	return false;
}

BoostedProc.EVERY_3RD = new UsageBoostedProc(3);
BoostedProc.EVERY_4TH = new UsageBoostedProc(4);

function Move(name, cd) {
	if (arguments.length == 0) return;
	this.name = name;
	this.cooldown = cd;
	// Values not common enough to justify an argument
	this.storedUses = 1;
	this.resetsBoosted = false;
}
Move.prototype.setStore = function(u) {
	this.storedUses = u;
	return this;
}
Move.prototype.setBoost = function() {
	this.resetsBoosted = true;
	return this;
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

function StatusMove(name, dur, stats, cd) {
	if (arguments.length == 0) return;
	Move.call(this, name, cd);
	this.duration = dur;
	this.stats = stats;
}
StatusMove.prototype = new Move();
StatusMove.prototype.constructor = StatusMove;

function DebuffMove(name, dur, stats, cd) {
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
}
HealthModMove.prototype = new Move();
HealthModMove.prototype.constructor = HealthModMove;

function DamagingMove(name, pmux, smux, lev, flat, cd) {
	if (arguments.length == 0) return;
	HealthModMove.apply(this, arguments);
}
DamagingMove.prototype = new HealthModMove();
DamagingMove.prototype.constructor = DamagingMove;

function HealingMove(name, pmux, smux, lev, flat, cd) {
	if (arguments.length == 0) return;
	HealthModMove.apply(this, arguments);
}
HealingMove.prototype = new HealthModMove();
HealingMove.prototype.constructor = HealingMove;

Move.BASIC = new DamagingMove("Basic", 1, 0, 0, 0, 0);

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
Item.LIST = {
	'': new Item("", [ // dummy item
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
			new Stats(),
		], [0, 0, 0], Passive.DUMMY),
	// Item values from https://gamewith.net/pokemon-unite/
	AeosCookie: new Item("AeosCookie", [
			new Stats({health: 8}),
			new Stats({health: 16}),
			new Stats({health: 24}),
			new Stats({health: 32}),
			new Stats({health: 40}),
			new Stats({health: 48}),
			new Stats({health: 56}),
			new Stats({health: 64}),
			new Stats({health: 72}),
			new Stats({health: 80}),
			new Stats({health: 88}),
			new Stats({health: 96}),
			new Stats({health: 104}),
			new Stats({health: 112}),
			new Stats({health: 120}),
			new Stats({health: 128}),
			new Stats({health: 136}),
			new Stats({health: 144}),
			new Stats({health: 152}),
			new Stats({health: 160}),
			new Stats({health: 168}),
			new Stats({health: 176}),
			new Stats({health: 184}),
			new Stats({health: 192}),
			new Stats({health: 200}),
			new Stats({health: 208}),
			new Stats({health: 216}),
			new Stats({health: 224}),
			new Stats({health: 232}),
			new Stats({health: 240}),
		], [100, 150, 200], new ScoreScalingPassive("health")),
	AssaultVest: new Item("AssaultVest", [
			new Stats({health: 18, spdefense: 0}),
			new Stats({health: 18, spdefense: 2.8}),
			new Stats({health: 36, spdefense: 2.8}),
			new Stats({health: 36, spdefense: 5.6}),
			new Stats({health: 54, spdefense: 5.6}),
			new Stats({health: 54, spdefense: 8.4}),
			new Stats({health: 72, spdefense: 8.4}),
			new Stats({health: 72, spdefense: 11.2}),
			new Stats({health: 90, spdefense: 11.2}),
			new Stats({health: 90, spdefense: 14}),
			new Stats({health: 108, spdefense: 14}),
			new Stats({health: 108, spdefense: 16.8}),
			new Stats({health: 126, spdefense: 16.8}),
			new Stats({health: 126, spdefense: 19.6}),
			new Stats({health: 144, spdefense: 19.6}),
			new Stats({health: 144, spdefense: 22.4}),
			new Stats({health: 162, spdefense: 22.4}),
			new Stats({health: 162, spdefense: 25.2}),
			new Stats({health: 180, spdefense: 25.2}),
			new Stats({health: 180, spdefense: 28}),
			new Stats({health: 198, spdefense: 28}),
			new Stats({health: 198, spdefense: 30.8}),
			new Stats({health: 216, spdefense: 30.8}),
			new Stats({health: 216, spdefense: 33.6}),
			new Stats({health: 234, spdefense: 33.6}),
			new Stats({health: 234, spdefense: 36.4}),
			new Stats({health: 252, spdefense: 36.4}),
			new Stats({health: 252, spdefense: 39.2}),
			new Stats({health: 270, spdefense: 39.2}),
			new Stats({health: 270, spdefense: 42}),
		], [0.09, 0.12, 0.15], Passive.DUMMY/*spdef shield*/),
	BuddyBarrier: new Item("BuddyBarrier", [
			new Stats({health: 20}),
			new Stats({health: 40}),
			new Stats({health: 60}),
			new Stats({health: 80}),
			new Stats({health: 100}),
			new Stats({health: 120}),
			new Stats({health: 140}),
			new Stats({health: 160}),
			new Stats({health: 180}),
			new Stats({health: 200}),
			new Stats({health: 220}),
			new Stats({health: 240}),
			new Stats({health: 260}),
			new Stats({health: 280}),
			new Stats({health: 300}),
			new Stats({health: 320}),
			new Stats({health: 340}),
			new Stats({health: 360}),
			new Stats({health: 380}),
			new Stats({health: 400}),
			new Stats({health: 420}),
			new Stats({health: 440}),
			new Stats({health: 460}),
			new Stats({health: 480}),
			new Stats({health: 500}),
			new Stats({health: 520}),
			new Stats({health: 540}),
			new Stats({health: 560}),
			new Stats({health: 580}),
			new Stats({health: 600}),
		], [0.2, 0.3, 0.4], Passive.DUMMY/*unite shield*/),
	AttackWeight: new Item("AttackWeight", [
			new Stats({attack: 0.6}),
			new Stats({attack: 1.2}),
			new Stats({attack: 1.8}),
			new Stats({attack: 2.4}),
			new Stats({attack: 3}),
			new Stats({attack: 3.6}),
			new Stats({attack: 4.2}),
			new Stats({attack: 4.8}),
			new Stats({attack: 5.4}),
			new Stats({attack: 6}),
			new Stats({attack: 6.6}),
			new Stats({attack: 7.2}),
			new Stats({attack: 7.8}),
			new Stats({attack: 8.4}),
			new Stats({attack: 9}),
			new Stats({attack: 9.6}),
			new Stats({attack: 10.2}),
			new Stats({attack: 10.8}),
			new Stats({attack: 11.4}),
			new Stats({attack: 12}),
			new Stats({attack: 12.6}),
			new Stats({attack: 13.2}),
			new Stats({attack: 13.8}),
			new Stats({attack: 14.4}),
			new Stats({attack: 15}),
			new Stats({attack: 15.6}),
			new Stats({attack: 16.2}),
			new Stats({attack: 16.8}),
			new Stats({attack: 17.4}),
			new Stats({attack: 18}),
		], [6, 9, 12], new ScoreScalingPassive("attack")),
	ChoiceSpecs: new Item("ChoiceSpecs", [
			new Stats({spattack: 10}),
			new Stats({spattack: 11}),
			new Stats({spattack: 12}),
			new Stats({spattack: 13}),
			new Stats({spattack: 14}),
			new Stats({spattack: 15}),
			new Stats({spattack: 16}),
			new Stats({spattack: 17}),
			new Stats({spattack: 18}),
			new Stats({spattack: 19}),
			new Stats({spattack: 20}),
			new Stats({spattack: 21}),
			new Stats({spattack: 22}),
			new Stats({spattack: 23}),
			new Stats({spattack: 24}),
			new Stats({spattack: 25}),
			new Stats({spattack: 26}),
			new Stats({spattack: 27}),
			new Stats({spattack: 28}),
			new Stats({spattack: 29}),
			new Stats({spattack: 30}),
			new Stats({spattack: 31}),
			new Stats({spattack: 32}),
			new Stats({spattack: 33}),
			new Stats({spattack: 34}),
			new Stats({spattack: 35}),
			new Stats({spattack: 36}),
			new Stats({spattack: 37}),
			new Stats({spattack: 38}),
			new Stats({spattack: 39}),
		], [40, 50, 60], Passive.DUMMY/*cooldown boost*/),
	EnergyAmplifier: new Item("EnergyAmplifier", [
			new Stats({charge: 0.004, cdr: 0}),
			new Stats({charge: 0.004, cdr: 0.003}),
			new Stats({charge: 0.008, cdr: 0.003}),
			new Stats({charge: 0.008, cdr: 0.006}),
			new Stats({charge: 0.012, cdr: 0.006}),
			new Stats({charge: 0.012, cdr: 0.009}),
			new Stats({charge: 0.016, cdr: 0.009}),
			new Stats({charge: 0.016, cdr: 0.012}),
			new Stats({charge: 0.02, cdr: 0.012}),
			new Stats({charge: 0.02, cdr: 0.015}),
			new Stats({charge: 0.024, cdr: 0.015}),
			new Stats({charge: 0.024, cdr: 0.018}),
			new Stats({charge: 0.028, cdr: 0.018}),
			new Stats({charge: 0.028, cdr: 0.021}),
			new Stats({charge: 0.032, cdr: 0.021}),
			new Stats({charge: 0.032, cdr: 0.024}),
			new Stats({charge: 0.036, cdr: 0.024}),
			new Stats({charge: 0.036, cdr: 0.027}),
			new Stats({charge: 0.04, cdr: 0.027}),
			new Stats({charge: 0.04, cdr: 0.03}),
			new Stats({charge: 0.044, cdr: 0.03}),
			new Stats({charge: 0.044, cdr: 0.033}),
			new Stats({charge: 0.048, cdr: 0.033}),
			new Stats({charge: 0.048, cdr: 0.036}),
			new Stats({charge: 0.052, cdr: 0.036}),
			new Stats({charge: 0.052, cdr: 0.039}),
			new Stats({charge: 0.056, cdr: 0.039}),
			new Stats({charge: 0.056, cdr: 0.042}),
			new Stats({charge: 0.06, cdr: 0.042}),
			new Stats({charge: 0.06, cdr: 0.045}),
		], [0.07, 0.14, 0.21], Passive.DUMMY/*unite damage boost*/),
	ExpShare: new Item("ExpShare", [
			new Stats({health: 16, movement: 0}),
			new Stats({health: 16, movement: 10}),
			new Stats({health: 32, movement: 10}),
			new Stats({health: 32, movement: 20}),
			new Stats({health: 48, movement: 20}),
			new Stats({health: 48, movement: 30}),
			new Stats({health: 64, movement: 30}),
			new Stats({health: 64, movement: 40}),
			new Stats({health: 80, movement: 40}),
			new Stats({health: 80, movement: 50}),
			new Stats({health: 96, movement: 50}),
			new Stats({health: 96, movement: 60}),
			new Stats({health: 112, movement: 60}),
			new Stats({health: 112, movement: 70}),
			new Stats({health: 128, movement: 70}),
			new Stats({health: 128, movement: 80}),
			new Stats({health: 144, movement: 80}),
			new Stats({health: 144, movement: 90}),
			new Stats({health: 160, movement: 90}),
			new Stats({health: 160, movement: 100}),
			new Stats({health: 176, movement: 100}),
			new Stats({health: 176, movement: 110}),
			new Stats({health: 192, movement: 110}),
			new Stats({health: 192, movement: 120}),
			new Stats({health: 208, movement: 120}),
			new Stats({health: 208, movement: 130}),
			new Stats({health: 224, movement: 130}),
			new Stats({health: 224, movement: 140}),
			new Stats({health: 240, movement: 140}),
			new Stats({health: 240, movement: 150}),
		], [2, 3, 4], Passive.DUMMY/*XXX will never implement*/),
	FloatStone: new Item("FloatStone", [
			new Stats({attack: 1.6, movement: 0}),
			new Stats({attack: 1.6, movement: 8}),
			new Stats({attack: 3.2, movement: 8}),
			new Stats({attack: 3.2, movement: 16}),
			new Stats({attack: 4.8, movement: 16}),
			new Stats({attack: 4.8, movement: 24}),
			new Stats({attack: 6.4, movement: 24}),
			new Stats({attack: 6.4, movement: 32}),
			new Stats({attack: 8, movement: 32}),
			new Stats({attack: 8, movement: 40}),
			new Stats({attack: 9.6, movement: 40}),
			new Stats({attack: 9.6, movement: 48}),
			new Stats({attack: 11.2, movement: 48}),
			new Stats({attack: 11.2, movement: 56}),
			new Stats({attack: 12.8, movement: 56}),
			new Stats({attack: 12.8, movement: 64}),
			new Stats({attack: 14.4, movement: 64}),
			new Stats({attack: 14.4, movement: 72}),
			new Stats({attack: 16, movement: 72}),
			new Stats({attack: 16, movement: 80}),
			new Stats({attack: 17.6, movement: 80}),
			new Stats({attack: 17.6, movement: 88}),
			new Stats({attack: 19.2, movement: 88}),
			new Stats({attack: 19.2, movement: 96}),
			new Stats({attack: 20.8, movement: 96}),
			new Stats({attack: 20.8, movement: 104}),
			new Stats({attack: 22.4, movement: 104}),
			new Stats({attack: 22.4, movement: 112}),
			new Stats({attack: 24, movement: 112}),
			new Stats({attack: 24, movement: 120}),
		], [0.10, 0.15, 0.20], new PercentItemPassive("movement")),
	FocusBand: new Item("FocusBand", [
			new Stats({spdefense: 2, defense: 0}),
			new Stats({spdefense: 2, defense: 2}),
			new Stats({spdefense: 4, defense: 2}),
			new Stats({spdefense: 4, defense: 4}),
			new Stats({spdefense: 6, defense: 4}),
			new Stats({spdefense: 6, defense: 6}),
			new Stats({spdefense: 8, defense: 6}),
			new Stats({spdefense: 8, defense: 8}),
			new Stats({spdefense: 10, defense: 8}),
			new Stats({spdefense: 10, defense: 10}),
			new Stats({spdefense: 12, defense: 10}),
			new Stats({spdefense: 12, defense: 12}),
			new Stats({spdefense: 14, defense: 12}),
			new Stats({spdefense: 14, defense: 14}),
			new Stats({spdefense: 16, defense: 14}),
			new Stats({spdefense: 16, defense: 16}),
			new Stats({spdefense: 18, defense: 16}),
			new Stats({spdefense: 18, defense: 18}),
			new Stats({spdefense: 20, defense: 18}),
			new Stats({spdefense: 20, defense: 20}),
			new Stats({spdefense: 22, defense: 20}),
			new Stats({spdefense: 22, defense: 22}),
			new Stats({spdefense: 24, defense: 22}),
			new Stats({spdefense: 24, defense: 24}),
			new Stats({spdefense: 26, defense: 24}),
			new Stats({spdefense: 26, defense: 26}),
			new Stats({spdefense: 28, defense: 26}),
			new Stats({spdefense: 28, defense: 28}),
			new Stats({spdefense: 30, defense: 28}),
			new Stats({spdefense: 30, defense: 30}),
		], [0.08, 0.11, 0.14], Passive.DUMMY/*shield on low health*/),
	Leftovers: new Item("Leftovers", [
			new Stats({health: 16, recovery: 0}),
			new Stats({health: 16, recovery: 0.6}),
			new Stats({health: 32, recovery: 0.6}),
			new Stats({health: 32, recovery: 1.2}),
			new Stats({health: 48, recovery: 1.2}),
			new Stats({health: 48, recovery: 1.8}),
			new Stats({health: 64, recovery: 1.8}),
			new Stats({health: 64, recovery: 2.4}),
			new Stats({health: 80, recovery: 2.4}),
			new Stats({health: 80, recovery: 3}),
			new Stats({health: 96, recovery: 3}),
			new Stats({health: 96, recovery: 3.6}),
			new Stats({health: 112, recovery: 3.6}),
			new Stats({health: 112, recovery: 4.2}),
			new Stats({health: 128, recovery: 4.2}),
			new Stats({health: 128, recovery: 4.8}),
			new Stats({health: 144, recovery: 4.8}),
			new Stats({health: 144, recovery: 5.4}),
			new Stats({health: 160, recovery: 5.4}),
			new Stats({health: 160, recovery: 6}),
			new Stats({health: 176, recovery: 6}),
			new Stats({health: 176, recovery: 6.6}),
			new Stats({health: 192, recovery: 6.6}),
			new Stats({health: 192, recovery: 7.2}),
			new Stats({health: 208, recovery: 7.2}),
			new Stats({health: 208, recovery: 7.8}),
			new Stats({health: 224, recovery: 7.8}),
			new Stats({health: 224, recovery: 8.4}),
			new Stats({health: 240, recovery: 8.4}),
			new Stats({health: 240, recovery: 9}),
		], [0.01, 0.015, 0.02], Passive.DUMMY/*XXX never implement*/),
	MuscleBand: new Item("MuscleBand", [
			new Stats({attack: 1, aps: 0.0}),
			new Stats({attack: 1, aps: 0.5}),
			new Stats({attack: 2, aps: 0.5}),
			new Stats({attack: 2, aps: 1.0}),
			new Stats({attack: 3, aps: 1.0}),
			new Stats({attack: 3, aps: 1.5}),
			new Stats({attack: 4, aps: 1.5}),
			new Stats({attack: 4, aps: 2.0}),
			new Stats({attack: 5, aps: 2.0}),
			new Stats({attack: 5, aps: 2.5}),
			new Stats({attack: 6, aps: 2.5}),
			new Stats({attack: 6, aps: 3.0}),
			new Stats({attack: 7, aps: 3.0}),
			new Stats({attack: 7, aps: 3.5}),
			new Stats({attack: 8, aps: 3.5}),
			new Stats({attack: 8, aps: 4.0}),
			new Stats({attack: 9, aps: 4.0}),
			new Stats({attack: 9, aps: 4.5}),
			new Stats({attack: 10, aps: 4.5}),
			new Stats({attack: 10, aps: 5.0}),
			new Stats({attack: 11, aps: 5.0}),
			new Stats({attack: 11, aps: 5.5}),
			new Stats({attack: 12, aps: 5.5}),
			new Stats({attack: 12, aps: 6.0}),
			new Stats({attack: 13, aps: 6.0}),
			new Stats({attack: 13, aps: 6.5}),
			new Stats({attack: 14, aps: 6.5}),
			new Stats({attack: 14, aps: 7.0}),
			new Stats({attack: 15, aps: 7.0}),
			new Stats({attack: 15, aps: 7.5}),
		], [0.01, 0.02, 0.03], Passive.DUMMY/*bonus basic attack dmg*/),
	RazorClaw: new Item("RazorClaw", [
			new Stats({attack: 1, critrate: 0.006}),
			new Stats({attack: 1, critrate: 0.007}),
			new Stats({attack: 2, critrate: 0.007}),
			new Stats({attack: 2, critrate: 0.008}),
			new Stats({attack: 3, critrate: 0.008}),
			new Stats({attack: 3, critrate: 0.009}),
			new Stats({attack: 4, critrate: 0.009}),
			new Stats({attack: 4, critrate: 0.01}),
			new Stats({attack: 5, critrate: 0.01}),
			new Stats({attack: 5, critrate: 0.011}),
			new Stats({attack: 6, critrate: 0.011}),
			new Stats({attack: 6, critrate: 0.012}),
			new Stats({attack: 7, critrate: 0.012}),
			new Stats({attack: 7, critrate: 0.013}),
			new Stats({attack: 8, critrate: 0.013}),
			new Stats({attack: 8, critrate: 0.014}),
			new Stats({attack: 9, critrate: 0.014}),
			new Stats({attack: 9, critrate: 0.015}),
			new Stats({attack: 10, critrate: 0.015}),
			new Stats({attack: 10, critrate: 0.016}),
			new Stats({attack: 11, critrate: 0.016}),
			new Stats({attack: 11, critrate: 0.017}),
			new Stats({attack: 12, critrate: 0.017}),
			new Stats({attack: 12, critrate: 0.018}),
			new Stats({attack: 13, critrate: 0.018}),
			new Stats({attack: 13, critrate: 0.019}),
			new Stats({attack: 14, critrate: 0.019}),
			new Stats({attack: 14, critrate: 0.02}),
			new Stats({attack: 15, critrate: 0.02}),
			new Stats({attack: 15, critrate: 0.021}),
		], [10, 15, 20], Passive.DUMMY/*bonus basic attack dmg*/),
	RockyHelmet: new Item("RockyHelmet", [
			new Stats({health: 18, defense: 0}),
			new Stats({health: 18, defense: 2.8}),
			new Stats({health: 36, defense: 2.8}),
			new Stats({health: 36, defense: 5.6}),
			new Stats({health: 54, defense: 5.6}),
			new Stats({health: 54, defense: 8.4}),
			new Stats({health: 72, defense: 8.4}),
			new Stats({health: 72, defense: 11.2}),
			new Stats({health: 90, defense: 11.2}),
			new Stats({health: 90, defense: 14}),
			new Stats({health: 108, defense: 14}),
			new Stats({health: 108, defense: 16.8}),
			new Stats({health: 126, defense: 16.8}),
			new Stats({health: 126, defense: 19.6}),
			new Stats({health: 144, defense: 19.6}),
			new Stats({health: 144, defense: 22.4}),
			new Stats({health: 162, defense: 22.4}),
			new Stats({health: 162, defense: 25.2}),
			new Stats({health: 180, defense: 25.2}),
			new Stats({health: 180, defense: 28}),
			new Stats({health: 198, defense: 28}),
			new Stats({health: 198, defense: 30.8}),
			new Stats({health: 216, defense: 30.8}),
			new Stats({health: 216, defense: 33.6}),
			new Stats({health: 234, defense: 33.6}),
			new Stats({health: 234, defense: 36.4}),
			new Stats({health: 252, defense: 36.4}),
			new Stats({health: 252, defense: 39.2}),
			new Stats({health: 270, defense: 39.2}),
			new Stats({health: 270, defense: 42}),
		], [0.03, 0.04, 0.05], Passive.DUMMY/*damage when hit*/),
	ScopeLens: new Item("ScopeLens", [
			new Stats({critrate: 0.004, critdamage: 0}),
			new Stats({critrate: 0.004, critdamage: 0.008}),
			new Stats({critrate: 0.008, critdamage: 0.008}),
			new Stats({critrate: 0.008, critdamage: 0.016}),
			new Stats({critrate: 0.012, critdamage: 0.016}),
			new Stats({critrate: 0.012, critdamage: 0.024}),
			new Stats({critrate: 0.016, critdamage: 0.024}),
			new Stats({critrate: 0.016, critdamage: 0.032}),
			new Stats({critrate: 0.02, critdamage: 0.032}),
			new Stats({critrate: 0.02, critdamage: 0.04}),
			new Stats({critrate: 0.024, critdamage: 0.04}),
			new Stats({critrate: 0.024, critdamage: 0.048}),
			new Stats({critrate: 0.028, critdamage: 0.048}),
			new Stats({critrate: 0.028, critdamage: 0.056}),
			new Stats({critrate: 0.032, critdamage: 0.056}),
			new Stats({critrate: 0.032, critdamage: 0.064}),
			new Stats({critrate: 0.036, critdamage: 0.064}),
			new Stats({critrate: 0.036, critdamage: 0.072}),
			new Stats({critrate: 0.04, critdamage: 0.072}),
			new Stats({critrate: 0.04, critdamage: 0.08}),
			new Stats({critrate: 0.044, critdamage: 0.08}),
			new Stats({critrate: 0.044, critdamage: 0.088}),
			new Stats({critrate: 0.048, critdamage: 0.088}),
			new Stats({critrate: 0.048, critdamage: 0.096}),
			new Stats({critrate: 0.052, critdamage: 0.096}),
			new Stats({critrate: 0.052, critdamage: 0.104}),
			new Stats({critrate: 0.056, critdamage: 0.104}),
			new Stats({critrate: 0.056, critdamage: 0.112}),
			new Stats({critrate: 0.06, critdamage: 0.112}),
			new Stats({critrate: 0.06, critdamage: 0.12}),
		], [0.45, 0.6, 0.75], Passive.DUMMY/* bonus crit dmg of atk,
						    * 1s cd*/),
	ScoreShield: new Item("ScoreShield", [
			new Stats({health: 15}),
			new Stats({health: 30}),
			new Stats({health: 45}),
			new Stats({health: 60}),
			new Stats({health: 75}),
			new Stats({health: 90}),
			new Stats({health: 105}),
			new Stats({health: 120}),
			new Stats({health: 135}),
			new Stats({health: 150}),
			new Stats({health: 165}),
			new Stats({health: 180}),
			new Stats({health: 195}),
			new Stats({health: 210}),
			new Stats({health: 225}),
			new Stats({health: 240}),
			new Stats({health: 255}),
			new Stats({health: 270}),
			new Stats({health: 285}),
			new Stats({health: 300}),
			new Stats({health: 315}),
			new Stats({health: 330}),
			new Stats({health: 345}),
			new Stats({health: 360}),
			new Stats({health: 375}),
			new Stats({health: 390}),
			new Stats({health: 405}),
			new Stats({health: 420}),
			new Stats({health: 435}),
			new Stats({health: 450}),
		], [0.05, 0.075, 0.1], Passive.DUMMY/*unlikely to implement*/),
	ShellBell: new Item("ShellBell", [
			new Stats({spattack: 1.6, cdr: 0}),
			new Stats({spattack: 1.6, cdr: 0.003}),
			new Stats({spattack: 3.2, cdr: 0.003}),
			new Stats({spattack: 3.2, cdr: 0.006}),
			new Stats({spattack: 4.8, cdr: 0.006}),
			new Stats({spattack: 4.8, cdr: 0.009}),
			new Stats({spattack: 6.4, cdr: 0.009}),
			new Stats({spattack: 6.4, cdr: 0.012}),
			new Stats({spattack: 8, cdr: 0.012}),
			new Stats({spattack: 8, cdr: 0.015}),
			new Stats({spattack: 9.6, cdr: 0.015}),
			new Stats({spattack: 9.6, cdr: 0.018}),
			new Stats({spattack: 11.2, cdr: 0.018}),
			new Stats({spattack: 11.2, cdr: 0.021}),
			new Stats({spattack: 12.8, cdr: 0.021}),
			new Stats({spattack: 12.8, cdr: 0.024}),
			new Stats({spattack: 14.4, cdr: 0.024}),
			new Stats({spattack: 14.4, cdr: 0.027}),
			new Stats({spattack: 16, cdr: 0.027}),
			new Stats({spattack: 16, cdr: 0.03}),
			new Stats({spattack: 17.6, cdr: 0.03}),
			new Stats({spattack: 17.6, cdr: 0.033}),
			new Stats({spattack: 19.2, cdr: 0.033}),
			new Stats({spattack: 19.2, cdr: 0.036}),
			new Stats({spattack: 20.8, cdr: 0.036}),
			new Stats({spattack: 20.8, cdr: 0.039}),
			new Stats({spattack: 22.4, cdr: 0.039}),
			new Stats({spattack: 22.4, cdr: 0.042}),
			new Stats({spattack: 24, cdr: 0.042}),
			new Stats({spattack: 24, cdr: 0.045}),
		], [45, 60, 75], Passive.DUMMY/*healing on dmg*/),
	SpAtkSpecs: new Item("SpAtkSpecs", [
			new Stats({spattack: 0.8}),
			new Stats({spattack: 1.6}),
			new Stats({spattack: 2.4}),
			new Stats({spattack: 3.2}),
			new Stats({spattack: 4}),
			new Stats({spattack: 4.8}),
			new Stats({spattack: 5.6}),
			new Stats({spattack: 6.4}),
			new Stats({spattack: 7.2}),
			new Stats({spattack: 8}),
			new Stats({spattack: 8.8}),
			new Stats({spattack: 9.6}),
			new Stats({spattack: 10.4}),
			new Stats({spattack: 11.2}),
			new Stats({spattack: 12}),
			new Stats({spattack: 12.8}),
			new Stats({spattack: 13.6}),
			new Stats({spattack: 14.4}),
			new Stats({spattack: 15.2}),
			new Stats({spattack: 16}),
			new Stats({spattack: 16.8}),
			new Stats({spattack: 17.6}),
			new Stats({spattack: 18.4}),
			new Stats({spattack: 19.2}),
			new Stats({spattack: 20}),
			new Stats({spattack: 20.8}),
			new Stats({spattack: 21.6}),
			new Stats({spattack: 22.4}),
			new Stats({spattack: 23.2}),
			new Stats({spattack: 24}),
		], [8, 12, 16], new ScoreScalingPassive("spattack")),
	WeaknessPolicy: new Item("WeaknessPolicy", [
			new Stats({health: 70, attack: 0}),
			new Stats({health: 70, attack: 1}),
			new Stats({health: 80, attack: 1}),
			new Stats({health: 80, attack: 2}),
			new Stats({health: 90, attack: 2}),
			new Stats({health: 90, attack: 3}),
			new Stats({health: 100, attack: 3}),
			new Stats({health: 100, attack: 4}),
			new Stats({health: 110, attack: 4}),
			new Stats({health: 110, attack: 5}),
			new Stats({health: 120, attack: 5}),
			new Stats({health: 120, attack: 6}),
			new Stats({health: 130, attack: 6}),
			new Stats({health: 130, attack: 7}),
			new Stats({health: 140, attack: 7}),
			new Stats({health: 140, attack: 8}),
			new Stats({health: 150, attack: 8}),
			new Stats({health: 150, attack: 9}),
			new Stats({health: 160, attack: 9}),
			new Stats({health: 160, attack: 10}),
			new Stats({health: 170, attack: 10}),
			new Stats({health: 170, attack: 11}),
			new Stats({health: 180, attack: 11}),
			new Stats({health: 180, attack: 12}),
			new Stats({health: 190, attack: 12}),
			new Stats({health: 190, attack: 13}),
			new Stats({health: 200, attack: 13}),
			new Stats({health: 200, attack: 14}),
			new Stats({health: 210, attack: 14}),
			new Stats({health: 210, attack: 15}),
		], [0.02, 0.025, 0.03], Passive.DUMMY/*increase dmg when hit*/),
	WiseGlasses: new Item("WiseGlasses", [
			new Stats({spattack: 10}),
			new Stats({spattack: 11}),
			new Stats({spattack: 12}),
			new Stats({spattack: 13}),
			new Stats({spattack: 14}),
			new Stats({spattack: 15}),
			new Stats({spattack: 16}),
			new Stats({spattack: 17}),
			new Stats({spattack: 18}),
			new Stats({spattack: 19}),
			new Stats({spattack: 20}),
			new Stats({spattack: 21}),
			new Stats({spattack: 22}),
			new Stats({spattack: 23}),
			new Stats({spattack: 24}),
			new Stats({spattack: 25}),
			new Stats({spattack: 26}),
			new Stats({spattack: 27}),
			new Stats({spattack: 28}),
			new Stats({spattack: 29}),
			new Stats({spattack: 30}),
			new Stats({spattack: 31}),
			new Stats({spattack: 32}),
			new Stats({spattack: 33}),
			new Stats({spattack: 34}),
			new Stats({spattack: 35}),
			new Stats({spattack: 36}),
			new Stats({spattack: 37}),
			new Stats({spattack: 38}),
			new Stats({spattack: 39}),
		], [0.03, 0.05, 0.07], new PercentItemPassive("spattack")),
};

function LearnSet(level, moves) {
	this.level = level;
	this.moves = moves;
}

function Pokemon(name, type, range, role, prog, moveset, bacond,
		 learnat1, learnset1, learnat2, learnset2,
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
			new LearnSet(learnat1, learnset1),
			new LearnSet(learnat2, learnset2),
			new LearnSet(uniteat, [null, unite]),
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
Pokemon.LIST = {
	/* Pokemon stat values from:
	 * https://docs.google.com/spreadsheets/d/1NYPIwDKTN1RaoiN7C9rG64rbNz8T0zw48-7SW5UEc94/edit#gid=223518408
	 * Vim Regex for adding new Pokemon: ,$ s/^\(\d\+\)\s\+\(\d\+\)\s\+\(\d\+\)\s\+\(\d\+\)\s\+\(\d\+\)\s\+\(\d\+\)\s\+\([0-9.]\+\)%\s\+\([0-9.]\+\)/\t\t\tnew Stats(\1, \2, \3, \4, \5, \7, \8),/
	 */

	/*
	Absol: new Pokemon("Absol",
			Pokemon.PHYSICAL, Pokemon.MELEE, Pokemon.SPEEDSTER, [
			new Stats(3000, 170, 52, 20, 36, 0.00, 1),
			new Stats(3107, 186, 59, 23, 41, 0.00, 1.018),
			new Stats(3224, 204, 67, 27, 47, 0.00, 1.036),
			new Stats(3353, 223, 76, 31, 53, 0.00, 1.054),
			new Stats(3495, 244, 86, 36, 60, 5.00, 1.072),
			new Stats(3651, 267, 97, 41, 68, 5.00, 1.09),
			new Stats(3823, 293, 109, 47, 76, 5.00, 1.108),
			new Stats(4012, 321, 122, 53, 85, 5.00, 1.126),
			new Stats(4221, 352, 136, 60, 95, 10.00, 1.144),
			new Stats(4451, 387, 152, 58, 106, 10.00, 1.162),
			new Stats(4704, 425, 170, 76, 118, 10.00, 1.18),
			new Stats(4983, 467, 189, 85, 131, 10.00, 1.198),
			new Stats(5290, 513, 210, 95, 146, 10.00, 1.216),
			new Stats(5628, 564, 233, 106, 162, 10.00, 1.234),
			new Stats(6000, 620, 259, 118, 180, 10.00, 1.252),
		], null, null, null, [
			// three attacks
		], [
			// three attacks
		], null),
	*/
	Cramorant: new Pokemon("Cramorant",
			Pokemon.SPECIAL, Pokemon.RANGED, Pokemon.ATTACKER, [
			new Stats(3292, 134,  60,  50,  40, 0.00, 0.95, 0,   0),
			new Stats(3399, 139,  69,  75,  46, 0.00, 0.95, 0,   0),
			new Stats(3517, 145,  78, 102,  52, 0.00, 0.95, 0,   0),
			new Stats(3647, 151,  88, 132,  59, 0.00, 0.95, 0,   0),
			new Stats(3789, 158,  99, 165,  67, 0.00, 0.95, 0.05,0),
			new Stats(3946, 166, 112, 201,  75, 0.00, 0.95, 0.05,0),
			new Stats(4118, 175, 126, 240,  84, 0.00, 0.95, 0.05,0),
			new Stats(4308, 185, 141, 283,  94, 0.00, 0.95, 0.05,0),
			new Stats(4517, 196, 158, 331, 105, 0.00, 0.95, 0.15,0),
			new Stats(4748, 208, 176, 384, 117, 0.00, 0.95, 0.15,0),
			new Stats(5002, 221, 196, 442, 131, 0.00, 0.95, 0.15,0),
			new Stats(5281, 235, 218, 506, 146, 0.00, 0.95, 0.15,0),
			new Stats(5589, 250, 243, 576, 162, 0.00, 0.95, 0.25,0),
			new Stats(5928, 267, 270, 654, 180, 0.00, 0.95, 0.25,0),
			new Stats(6301, 286, 300, 739, 200, 0.00, 0.95, 0.25,0),
		], {
			Basic: Move.BASIC,
			Boosted: new DamagingMove(
				"Boosted", 0,0.76, 16, 290, 0),
			WhirlpoolFirstTicks: new DamagingMove(
				"WhirlpoolFirstTicks", 0,0.24, 5, 100, 0),
			WhirlpoolMiddleTicks: new DamagingMove(
				"WhirlpoolMiddleTicks", 0,0.27, 6, 110, 0),
			WhirlpoolFinalTicks: new DamagingMove(
				"WhirlpoolFinalTicks", 0,0.3, 7, 120, 0),
			FeatherDance: new DebuffMove(
				"FeatherDance", 2/*Maybe get a real value*/,
				{aps: -0.3, movement:-0.2}, 8),
			SurfOut: new DamagingMove("SurfOut", 0,0.68, 9, 360, 0),
			SurfIn: new DamagingMove("SurfIn", 0,1.02, 14, 540, 0),
			Dive: new DamagingMove(
				"Dive", 0,0.78, 14, 320,
					4.5).setStore(3).setBoost(),
			"Dive+": new DamagingMove(
				"Dive+", 0,0.86, 16, 360,
					4.5).setStore(3).setBoost(),
			Hurricane: new DamagingMove(
				"Hurricane", 0,1.03, 10, 540, 9),
			AirSlashBlades: new DamagingMove(
				"AirSlashBlades", 0,0.35, 6, 150, 0),
			AirSlashHealing: new HealingMove(
				"AirSlashHealing", 0,0.3, 0, 60, 0),
			GatlingGulpOneMissile: new DamagingMove(
				"GatlingGulpOneMissile", 0,0.35, 6, 150, 0),
		}, BoostedProc.EVERY_4TH, 4, [
			new ComboMove("Whirlpool", 5, [
				"WhirlpoolFirstTicks",
				"WhirlpoolFirstTicks",
				"WhirlpoolMiddleTicks",
				"WhirlpoolMiddleTicks",
				"WhirlpoolFinalTicks",
				"WhirlpoolFinalTicks",
				"WhirlpoolFinalTicks",
				"WhirlpoolFinalTicks",
				"WhirlpoolFinalTicks",
				"WhirlpoolFinalTicks" ]),
			/* XXX Whirlpool should technically .setBoost() at the
			 *     end, but this requires manually entering the
			 *     Whirlpool, which will typically (although not
			 *     always) be cast far away from the user.
			 *     There is no real justification to always reset
			 *     the boosted attack counter, although it very
			 *     well should be part of advanced tactics when/if
			 *     those are ever added.
			 */
			new ComboMove(
				"Surf", 8, [ "SurfOut", "SurfIn" ]).setBoost(),
			null,
			"Dive", "Dive+",
		], 6, [
			"FeatherDance",
			"Hurricane", null,
			new ComboMove("AirSlash", 5, 4, "AirSlashBlade"),
			new ComboMove("AirSlash+", 5, [
				"AirSlashBlade", "AirSlashBlade",
				"AirSlashBlade", "AirSlashBlade",
				"AirSlashHealing", "AirSlashHealing",
				"AirSlashHealing", "AirSlashHealing" ]),
		], 9, new ComboMove("GatlingGulpMissile",
				0, 10, "GatlingGulpOneMissile"),
		Passive.DUMMY),
};

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

function Champion(poke, level, item1, ilev1, item2, ilev2, item3, ilev3) {
	this.pokemon = typeof(poke) === 'string' ? Pokemon.LIST[poke] : poke;
	this.level = level;
	this.stats = new Stats(this.pokemon.progression[this.level-1]);
	this.scores = 0;
	this.boostedCounter = 0;
	// Don't bother sorting items here; sort them when running longterm sims
	this.items = [	new ItemState(item1, ilev1),
			new ItemState(item2, ilev2),
			new ItemState(item3, ilev3) ];
	// Create easy hints reference so we don't have to recurse every access
	this.hints = this.pokemon.hints;
	for (var i=0; i<this.items.length; i++) {
		this.hints|= this.items[i].item.hints;
		this.items[i].addStats(this.stats);
	}
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
