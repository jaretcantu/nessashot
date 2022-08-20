/* search.js
 * Data structures and algorithms for searching and optimizing Pokemon UNITE
 * Copyright (C) 2021-2022 Jaret Jay Cantu
 * Licensed under the AGPL
 */

// classes

function Calc(name, prereq, func) {
	if (arguments.length == 0) return;
	this.name = name;
	this.prerequisites = prereq;
	this.calculate = func;
}
Calc.prototype.recurse = function(r, champ, enemy, param) {
	// Short-circuit if result is already populated
	if (isDefined(r[this.name]))
		return;

	// Populate anything that might be needed for this calculation
	for (var pr=0; pr<this.prerequisites.length; pr++)
		Calc.LIST[this.prerequisites[pr]].recurse(r, champ, enemy,
							  param);

	this.calculate(r, champ, enemy, param);
}
Calc.LIST = {
	"stats": new Calc("stats", [], function(r, champ, enemy, p) {
			for (var s=0; s<Stats.LIST.length; s++) {
				var stat = Stats.LIST[s];
				r[stat] = champ.stats[stat];
			}
		}),
	"physhp": new Calc("physhp", [], function(r, champ, enemy, p) {
			r.physhp = calcEffectiveHP(champ.stats.health,
						   champ.stats.defense);
		}),
	"spechp": new Calc("spechp", [], function(r, champ, enemy, p) {
			r.spechp = calcEffectiveHP(champ.stats.health,
						   champ.stats.spdefense);
		}),
	"tankiness": new Calc("tankiness", ["physhp", "spechp"],
		function(r, champ, enemy, p) {
			r.tankiness = r.physhp * (1-p.specialperc) +
				      r.spechp * p.specialperc;
		}),
};


// generic interface functions

function parseOption(parsed, arg, args, a) {
	var initialA = a;

	switch (arg) {
	case 'show':
		arg = args[++a];
		if (!isDefined(parsed.show))
			parsed.show = [];
		if (arg.indexOf(',') >= 0) {
			var shows = arg.split(',');
			for (var i=0; i<shows.length; i++)
				parsed.show.push(shows[i]);
		} else {
			parsed.show.push(arg);
		}
		break;
	case 'sort':
		arg = args[++a];
		if (!isDefined(parsed.sort))
			parsed.sort = [];
		if (arg.indexOf(',') >= 0) {
			var sorts = arg.split(',');
			for (var i=0; i<sorts.length; i++)
				parsed.sort.push(sorts[i]);
		} else {
			parsed.sort.push(arg);
		}
		break;
	case 'score':
		arg = args[++a];
		if (!isDefined(parsed.scores) || !parsed.scores)
			parsed.scores = [];
		if (arg.indexOf(',') >= 0) {
			var scores = arg.split(',');
			for (var i=0; i<scores.length; i++)
				parsed.scores.push(scores[i]);
		} else {
			parsed.scores.push(arg);
		}
		break;
	case 'levels':
		arg = args[++a];
		var split, l, i;
		// First obtain an array of all given levels
		if ((split=arg.indexOf('-')) > 0) {
			var min = arg.substring(0, split);
			var max = arg.substring(split+1);
			l = [];
			for (i=min; i<=max; i++)
				l.push(i);
		} else if (arg.indexOf(',') > 0) {
			l = arg.split(',');
		} else {
			l = [arg];
		}

		// Next check the validity of the given levels
		for (i=0; i<l.length; i++) {
			var lvl = l[i];
			if (isNaN(lvl))
				throw("Level is not a number: " + lvl);
			if (lvl < 1)
				throw("Level too low: " + lvl);
			if (lvl > 15)
				throw("Level too high: " + lvl);
			parsed.levels.push(lvl);
		}
		break;
	case 'item':
		arg = args[++a];
		var split = arg.indexOf('=');
		var i, l;
		if (split > 0) {
			i = arg.substring(0, split);
			l = arg.substring(split+1);
		} else {
			i = arg;
			l = parsed.itemlevels[i] || 0;
		}
		if (parsed.items.length >= 3) {
			throw("Too many items specified");
		} else if (!isDefined(Item.LIST[i])) {
			throw("Unknown item: " + i);
		}
		parsed.items.push(i);
		parsed.itemlevels[i] = l;
		break;
	case 'itemlevel':
		arg = args[++a];
		var split = arg.indexOf('=');
		var i, l;
		if (split > 0) {
			i = arg.substring(0, split);
			l = arg.substring(split+1);
		} else {
			throw("Invalid itemlevel " + arg +
				"; item=level expected");
		}
		if (!isDefined(Item.LIST[i]))
			throw("Unknown item: " + i);
		parsed.itemlevels[i] = l;
		break;
	case 'itemdefault':
		arg = args[++a];
		if (isNaN(arg))
			throw("Non-numeric default item level");
		if (arg < 1 || arg > 30)
			throw("Default item level out of range: " +
				arg + " (Should be 1-30)");
		parsed.itemdefault = arg;
		break;
	case 'move':
		arg = args[++a];
		if (parsed.moves.length >= 2) {
			throw("Too many moves specified");
		} else if (isNaN(arg)) {
			// if isNaN(), we can't check it yet
		} else if (arg > 2) {
			throw("Bad move index: " + arg);
		}
		parsed.moves.push(arg);
		break;
	case 'optimize':
		if (isDefined(parsed.search)) {
			throw("Already optimizing " + parsed.search +
				"; cannot search " + arg + ", too.");
		}
		arg = args[++a];
		var split = arg.indexOf('=');
		var o, v, needsArray;
		if (split > 0) {
			o = arg.substring(0, split);
			v = arg.substring(split+1);
		} else {
			o = arg;
			v = "";
		}
		// Check target and return array, when required
		switch (o) {
		case "items":
			needsArray = false;
			break;
		case "itemlevels":
			needsArray = true;
			break;
		default:
			throw("Unknown optimization: " + o);
		}
		parsed.search = o;
		if (needsArray) {
			parsed.searchargs = v == "" ? [] : v.split(",");
		} else {
			parsed.searchargs = v;
		}
		break;
	case 'specperc':
		arg = args[++a];
		if (isNaN(arg))
			throw("Invalid special tank percentage: " + arg);
		parsed.specialperc = arg / 100.0;
		break;
	default:
		throw("Unknown option: " + arg);
	}

	return a - initialA;
}

function calcTable(poke, levels, items, parsed, score) {
	var label = poke.name + ": " + items.join("/") + " @" + score;
	var result = [label];

	// TODO Determine show actions
	for (var l=0; l<levels.length; l++) {
		var r = {};
		var champ = new Champion(poke, levels[l],
					items[0][0], items[0][1],
					items[1][0], items[1][1],
					items[2][0], items[2][1], score);
		champ.init();

		for (var s=0; s<parsed.show.length; s++) {
			var sh = parsed.show[s];
			if (!isDefined(Calc.LIST[sh]))
				throw("Unknown show type " + sh);
			Calc.LIST[sh].recurse(r, champ, null, parsed);
		}

		result.push(r);
	}
	return result;
}

function calcTables(poke, levels, items, parsed) {
	var results = [];
	var hints;
	var scoreMax, scoreMin, i;

	if (!parsed.scores) {
		// Check hints
		hints = poke.hints;
		scoreMin = 0;
		for (i=0; i<items.length; i++) 
			hints |= Item.LIST[items[i][0]].hints;
		scoreMax = (hints & HINT_SCORE) ? 6 : 0;
	} else if (parsed.scores.length > 1) {
		scoreMin = parsed.scores[0];
		scoreMax = parsed.scores[1];
	} else {
		scoreMin = parsed.scores[0];
		scoreMax = parsed.scores[0];
	}

	// XXX TODO Multiplex crits (none/expected/max)
	for (i=scoreMin; i<=scoreMax; i++)
		results.push(calcTable(poke, levels, items, parsed, i));

	return results;
}

function createTables(parsed) {
	if (parsed === null)
		throw("Failed to parse arguments");
	if (!isDefined(parsed.pokemon))
		throw("No Pokemon specified");
	if (parsed.show.length == 0)
		parsed.show = ["stats"];
	var levelList = (parsed.levels.length > 0 ? parsed.levels :
					[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] );

	var poke = Pokemon.LIST[parsed.pokemon];

	// Iterators derived from arguments but not specified directly by them
	var iterMoves;
	var iterItems;
	var i;

	// fill out specified moves
	iterMoves = [];
	for (i=0; i<parsed.moves.length; i++) {
		var m = parsed.moves[i];
		if (!isNaN(m)) {
			if (iterMoves.length > 2)
				throw("Learning too many indexed moves");
			iterMoves.push([m]);
		} else {
			var ls, lm, moves;
MOVESTRING:		for (ls=0; ls<2; ls++) {
				moves = poke.learnset[ls].moves;
				for (lm=1; lm<moves.length; lm++) {
					if (moves[lm].name == m)
						break MOVESTRING;
				}
			}
			if (ls >= 2) {
				throw("Could not find move " + m +
					" in any learnset for " + poke.name);
			}
			if (!isDefined(iterMoves[ls]))
				iterMoves[ls] = [];
			// Convert 1-2, 3-4 indexing to learnset 1 or 2 ref
			iterMoves[ls].push(1 + ((lm-1)>>1));
		}
	}
	// Iterate all learnsets when unspecified
	for (i=0; i<2; i++)
		if (!isDefined(iterMoves[i]))
			iterMoves[i] = [1, 2];

	// fill out specified items
	var iterItems = []; // array of triples of pairs

	if (parsed.search == 'itemlevels') {
		// Determine which/how many item levels will be searched
		var leveledItems = []; // array of pairs
		var unleveledItems = []; // array of names
		for (i=0; i<parsed.items.length; i++) {
			var lvl = parsed.itemlevels[parsed.items[i]];
			if (lvl)
				leveledItems.push([parsed.items[i], lvl]);
			else
				unleveledItems.push(parsed.items[i]);
		}
		if (unleveledItems.length <= 1) {
			throw("Too few items without levels to optimize: " +
				unleveledItems.length + " (need at least 2)");
		}
		while ((leveledItems.length + unleveledItems.length) < 3)
			leveledItems.push(['', 0]);

		// Generate a level pool to share among unleveled items
		var levelPool = parsed.searchargs;
		if (!levelPool.length) {
			// Default to one thirty for search
			for (i=0; i<unleveledItems.length; i++)
				levelPool.push(i ? parsed.itemdefault : 30);
		} else if (levelPool.length != unleveledItems.length) {
			throw("Mismatch in the number of items without a " +
				"level (" + unleveledItems.length + ") and " +
				"the number of search levels (" +
				levelPool.length + ")");
		}

		// Create every permutation of levels, using packed byte arrays.
		// Mod iterator by remaining items to get index of next item.
		var levelsPacked = []; // simply for tracking
		// Number of permutations is length! (factorial)
		var fac=1;
		for (i=2; i<=levelPool.length; i++)
			fac*= i;
		for (i=0; i<fac; i++) {
			var packed = 0;
			var mask = 0;
			var c = i;
			for (var p=0; p<levelPool.length; p++) {
				var cpool = (levelPool.length-p);
				var li = c % cpool;
				var l=0, bit=1;
				while (l < levelPool.length) {
					if (!(mask & bit)) {
						// Unused bit; check index
						if (li == 0)
							break;
						li--;
					}
					l++;
					bit <<= 1;
				}
				mask |= bit;
				packed <<= 8;
				packed |= levelPool[l];
				// Shift permutation index
				c = Math.floor(c / cpool);
			}
			// Only add unique combinations
			if (!levelsPacked.contains(packed)) {
				levelsPacked.push(packed);
			}
		}

		// Multiplex leveled items X (unleveled items X level pool)
		for (i=0; i<levelsPacked.length; i++) {
			var j, set = [];
			// Transfer leveled items
			for (j=0; j<leveledItems.length; j++)
				set.push(leveledItems[j]);
			for (j=0; j<unleveledItems.length; j++) {
				set.push([unleveledItems[j],
					  (levelsPacked[i] >> (8*j)) & 0xff]);
			}
			iterItems.push(set);
		}
	} else if (parsed.search == 'items') {
		throw("Unimplemented");
		// XXX TODO Don't use special items on physical 'Mons
	} else { // no item search
		var specItems = [];
		for (i=0; i<parsed.items.length; i++) {
			var lvl = parsed.itemlevels[parsed.items[i]];
			specItems.push([parsed.items[i],
					lvl ? lvl : parsed.itemdefault]);
		}
		// Flesh out unspecified items
		while (specItems.length < 3)
			specItems.push(['', 0]);
		iterItems.push(specItems);
	}

	// Multiplex search parameters (NB: More multiplexing based on hints)
	var t, tables = [];
	for (i=0; i<iterItems.length; i++) {
		var tbl = calcTables(poke, levelList,
					iterItems[i],
					parsed);
		for (t=0; t<tbl.length; t++)
			tables.push(tbl[t]);
	}

	if (parsed.sort.length > 0) {
		tables.sort(function(a,b) {
				for (var s=0; s<parsed.sort.length; s++) {
					var e = parsed.sort[s];
					var cmp = (a[1][e] - b[1][e]);
					if (cmp) return cmp;
				}
				return 0;
			});
	}

	return tables;
}

