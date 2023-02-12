/* search.js
 * Data structures and algorithms for searching and optimizing Pokemon UNITE
 * Copyright (C) 2021-2023 Jaret Jay Cantu
 * Licensed under the AGPL
 */

// constants
var LEVEL_WEIGHT = {
	jungler: [0, 0, 1, 2, 10, 10, 10, 10, 10, 10, 10, 10, 10, 8, 5],
	high: [0, 1, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 6, 3],
	low: [0, 1, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 8, 4, 1],
	expshare: [0, 2, 10, 10, 10, 10, 10, 10, 10, 10, 10, 9, 6, 1, 0],
};

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
Calc.critCalc = function(r, champ, lbl, mv, enemy, param) {
	// common way of adding all crit rates
	var dmg = mv.calc(champ);
	if (!isDefined(param.crit) || !mv.canCrit()) {
		r[lbl] = dmg;
		return;
	}
	for (var c=0; c<param.crit.length; c++) {
		var sfx = param.crit.length > 1 ? param.crit[c] : '';
		switch (param.crit[c]) {
		case 'nc': // no crit
			r[lbl + sfx] = dmg;
			break;
		case 'fc': // full crit
			r[lbl + sfx] = dmg * (1 + champ.stats.critdamage);
			break;
		default:
			r[lbl + sfx] = dmg * ((1 - champ.stats.critrate) +
					(champ.stats.critrate *
					 (1 + champ.stats.critdamage)));
			
		}
	}
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
	"dumbdmg": new Calc("dumbdmg", [],
		function(r, champ, enemy, p) {
			var total = 0;
			var ms = champ.pokemon.moveset;
			for (var m in ms) {
				if (isDefined(ms[m].calc))
					total+= ms[m].calc(champ);
			}
			// TODO Calc boosted attacks better
			r.dumbdmg = total;
		}),
	"basic": new Calc("basic", [],
		function(r, champ, enemy, p) {
			Calc.critCalc(r, champ, 'basic',
				champ.pokemon.moveset.Basic,
				enemy, p);
		}),
	"boosted": new Calc("boosted", [],
		function(r, champ, enemy, p) {
			Calc.critCalc(r, champ, 'boosted',
				champ.pokemon.moveset.Boosted,
				enemy, p);
		}),
	"tpb": new Calc("tpb", [],
		function(r, champ, enemy, p) {
			r.tpb = champ.ticksPerBasic();
		}),
	"tpboosted": new Calc("tpboosted", [],
		function(r, champ, enemy, p) {
			champ.pokemon.boostedProc.set(champ);
			r.tpboosted = champ.ticksPerBoosted();
		}),
	"move1": new Calc("move1", [],
		function(r, champ, enemy, p) {
			// A Pokemon will always have at least one move.
			Calc.critCalc(r, champ, 'move1', champ.moves[0],
				enemy, p);
		}),
	"move2": new Calc("move2", [],
		function(r, champ, enemy, p) {
			// A Pokemon will always learn its first move in slot 0,
			// regardless of whether it is R or ZR.
			if (champ.moves.length >= 2)
				Calc.critCalc(r, champ, 'move2', champ.moves[1],
					enemy, p);
			else
				r.move2 = 0;
		}),
	"itemdmg": new Calc("itemdmg", [],
		function(r, champ, enemy, p) {
			var total = 0;
			for (var i=0; i<champ.items.length; i++) {
				total+= champ.items[i].item.calc(champ);
			}
			r.itemdmg = total;
		}),
	"itemdps": new Calc("itemdps", [],
		function(r, champ, enemy, p) {
			var total = 0;
			for (var i=0; i<champ.items.length; i++) {
				var item = champ.items[i].item;
				total+= item.calc(champ) / item.cooldown(champ);
			}
			r.itemdps = total;
		}),
	"instant": new Calc("instant", ["basic", "boosted", "move1", "move2",
					"itemdmg"],
		// Differs from burst damage in that it is untimed.
		// This is useful for increasing the damage of a moveset but
		// not for comparing the damages of two different movesets.
		function(r, champ, enemy, p) {
			r.instant = r.basic+r.boosted+r.move1+r.move2+r.itemdmg;
		}),
	"autos": new Calc("autos", ["basic", "boosted", "tpb", "itemdps"],
		function(r, champ, enemy, p) {
			var bpb = champ.basicsPerBoosted();
			var dmg = r.boosted + (bpb-1) * r.basic;
			var t = (bpb * r.tpb) / TICKS_PER_SECOND;
			r.autos = dmg / t + r.itemdps;
		}),
	"basicsdps": new Calc("basicsdps", ["basic", "tpb"],
		function(r, champ, enemy, p) {
			var dmg = r.basic;
			var t = (r.tpb) / TICKS_PER_SECOND;
			r.basicsdps = dmg / t;
		}),
	"boosteddps": new Calc("boosteddps", ["boosted", "tpboosted"],
		function(r, champ, enemy, p) {
			var dmg = r.boosted;
			var t = (r.tpboosted) / TICKS_PER_SECOND;
			r.boosteddps = dmg / t;
		}),
};


// generic interface functions

function parseOption(parsed, arg, args, a) {
	if (!isDefined(a)) a = 0;
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
	case 'crit':
		arg = args[++a].split(',');
		for (var c=0; c<arg.length; c++) {
			var cc = arg[c];
			switch (cc) {
			case 'floor':
			case 'min':
				cc = 'nc';
			case 'nc': // no crit
				break;
			case 'ceil':
			case 'max':
				cc = 'fc';
			case 'fc': // full crit
				break;
			case 'average':
			case 'avg':
				cc = '';
			case '': // expected crit rate over time
				break;
			default:
				throw('Unknown crit specifier: ' + cc);
			}
			arg[c] = cc;
		}
		parsed.crit = arg;
		break;
	case 'emblem': {
		var emblems = args[++a].split(',');
		for (var e=0; e<emblems.length; e++)
			parsed.emblems.push(emblems[e]);
		break; }
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
		case "emblems":
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
	case 'weight':
		arg = args[++a];
		parsed.levelWeight = arg;
		break;
	default:
		throw("Unknown option: " + arg);
	}

	return a - initialA;
}

function getCommonLabels() {
	/* This is a remarkably simple function since the possible common labels
	 * must all be in the first dataset and get pruned from there.
	 */
	var common = {};
	var initialize = true;
	for (var a=0; a<arguments.length; a++) {
		var dataset = arguments[a];
		for (var i=0; i<dataset.length; i++) {
			var labels = dataset[i][0];
			var unseen = Object.keys(common);
			for (var l=0; l<labels.length; l++) {
				var label = labels[l];
				if (initialize) {
					// seed all labels as common
					common[label] = true;
				} else if (isDefined(common[label])) {
					for (var r=0; r<unseen.length; r++) {
						if (unseen[r] != label)
							continue;
						// Mark as seen
						unseen.splice(r, 1);
						break;
					}
					if (unseen.length == 0)
						break; // saw everything
				}
			}
			if (initialize) {
				initialize = false;
			} else if (unseen.length > 0) {
				// mark labels as no longer common
				for (var u=0; u<unseen.length; u++)
					delete(common[unseen[u]]);
				// If nothing is left, abort
				if (Object.keys(common).length == 0)
					return [];
			}
		}
	}
	return Object.keys(common);
}

function removeCommonLabels(label0, common) {
	var label = label0.slice(); // copy
	for (var l=0; l<label.length; ) {
		if (common.contains(label[l])) {
			label.splice(l, 1);
		} else {
			l++;
		}
	}
	return label;
}

function calcSortFitness(entry, base, levels, levelWeight, parsed) {
	var fitness = 0;
	for (var i=0; i<parsed.sort.length; i++) {
		var s = parsed.sort[i];
		fitness*= 4; // early entires are more important than later ones
		// Calculate a percentage difference
		var newfit = 0;
		for (var l=0; l<levels.length; l++) {
			var lev = levels[l];
			var bs = base[lev][s];
			newfit+= ((entry[lev][s] - bs) / bs) * levelWeight[l+1];
		}
		fitness+= newfit / levelWeight[0];
	}
	return fitness;
}

function emblemExpand(tuples, list, colCon, statCon, pos,
		      tables, base, poke, levelList, items, moves,
		      levelWeight, parsed) {
	var t = tuples[pos];
	for (var amt=0; amt<=t[1]; amt++) {
		if (amt) {
			list.push(t[0]);
			// Check for end on each addition
			if (list.length == 10) {
				var page = new EmblemPage(list);
				// check effects against required constraints
				for (var c in colCon)
					if (!isDefined(page.colors[c]) ||
					    page.colors[c] < colCon[c])
						return;
				for (c in statCon)
					if (page.stats[c] < statCon[c])
						return;
				// if everything passed, run the page
				iterateEmblem(tables, base, poke, levelList,
					      items, page, moves, levelWeight,
					      parsed);
				// terminate this branch; nothing more to add
				// here or any higher position
				return;
			}
		}
		if (pos < tuples.length-1) {
			emblemExpand(tuples, list.slice(), // copy
				     colCon, statCon, pos+1,
				     tables, base, poke, levelList, items,
				     moves, levelWeight, parsed);
		}
	}
}

function iterateEmblem(tables, base, poke, levelList, items, emblems,
		       moves, levelWeight, parsed) {
	var tbl = calcTables(poke, levelList, items, emblems,
			     moves, levelWeight, parsed);
	for (t=0; t<tbl.length; t++) {
		var tt = tbl[t];
		if (parsed.sort.length > 0) {
			var fitness = calcSortFitness(tt, base, levelList,
							levelWeight, parsed);
			var append = true;
			tt.push(fitness);
			for (var s=0; s<tables.length; s++) {
				var ss = tables[s];
				if (fitness < ss[ss.length-1]) {
					tables.splice(s, 0, tt);
					append = false;
					break;
				}
			}
			/* Most entries should have a low fitness, so
			 * keep the list sorted from lowest to highest
			 * for speed.
			 * The cost of shifting and dropping entries at
			 * zero is probably more time efficient than
			 * reverse-sorting it.
			 */
			if (append)
				tables.push(tt);
			// TODO Make customizable table length
			if (tables.length > 100)
				tables.shift();
		} else {
			// XXX This will cause OoM errors; use sort to
			//     limit the size of the list.
			tables.push(tt);
		}
	}
}

function iterateEmblems(tables, base, poke, levelList, items, moves,
			levelWeight, parsed) {
	if (parsed.search == 'emblems') {
		// Create a simpler constraints list
		var colCon = {};
		var statCon = {};
		for (var e=0; e<parsed.searchargs.length; e++) {
			var pair = parsed.searchargs[e].split('=');
			var colCheck = pair[0].charAt(0).toUpperCase() +
                                          pair[0].substring(1).toLowerCase();
			if (isDefined(Emblem.COLORS[colCheck]))
				colCon[colCheck] = pair[1];
			else
				statCon[pair[0]] = pair[1];
		}
		// Put emblem list into searchable object
		var eTuples = [];
		for (e=0; e<parsed.emblems.length; e++) {
			var pair = parsed.emblems[e].split('=');
			// If the pair was a simple emblem, set count to 1
			if (pair.length == 1) pair[1] = 1;
			if (!isDefined(Emblem.LIST[pair[0]]))
				throw("No such emblem: " + pair[0]);
			pair[0] = Emblem.LIST[pair[0]];
			eTuples.push(pair);
		}
		emblemExpand(eTuples, [], colCon, statCon, 0,
			     tables, base, poke, levelList, items,
			     moves, levelWeight, parsed);
	} else { // no emblem search
		iterateEmblem(tables, base, poke, levelList, items,
			      (isDefined(parsed.emblems) ?
				new EmblemPage(parsed.emblems) : null),
			      moves, levelWeight, parsed);
	}
}

function calcTable(poke, levels, items, parsed, score, emblems, moves,
		   levelWeight) {
	var label = [poke.name, items.join("/"), emblems, 'Score='+score];
	var result = [label];

	// TODO Determine show actions
	for (var l=0; l<levels.length; l++) {
		var r = {};
		var champ = new Champion(poke, levels[l],
					items[0][0], items[0][1],
					items[1][0], items[1][1],
					items[2][0], items[2][1],
					0, moves[0], moves[1],
					score, emblems);
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

function calcTables(poke, levels, items, emblems, moves, levelWeight, parsed) {
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

	for (i=scoreMin; i<=scoreMax; i++)
		results.push(calcTable(poke, levels, items, parsed, i, emblems,
				       moves, levelWeight));

	return results;
}

function createTables(parsed) {
	if (parsed === null)
		throw("Failed to parse arguments");
	if (!isDefined(parsed.pokemon))
		throw("No Pokemon specified");
	if (parsed.show.length == 0)
		parsed.show = ["stats"];
	var levelList = (parsed.levels && parsed.levels.length > 0 ?
					parsed.levels :
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
			iterMoves[i] = [1]; // default to just the first move

	// fill out specified items
	var iterItems = []; // array of triples of pairs
	var noItem = ['',0];

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
		// XXX TODO Don't use special items on physical 'Mons
		var specItems = [];
		var remItems = [];
		// Remove empty placeholder
		for (var j in Item.LIST)
			if (j != '')
				remItems.push(j);
		for (i=0; i<parsed.items.length; i++) {
			var lvl = parsed.itemlevels[parsed.items[i]];
			specItems.push([parsed.items[i],
					lvl ? lvl : parsed.itemdefault]);
			// Remove specified items from the remaining list
			INNER: for (j=0; j<remItems.length; j++) {
				if (remItems[j] == parsed.items[i]) {
					remItems.splice(j, 1);
					break INNER;
				}
			}
		}
		
		/* Permutate every possible item combination; can do so easily
		 * by ensuring sets are made of remaining items a<b<c, where
		 * a, b, and c are indeces to the remaining item array.
		 */
		var recursor = function(items, cnt) {
			while (cnt < remItems.length) {
				var newItems = items.slice(); // copy
				newItems.push([remItems[cnt],
						parsed.itemdefault]);
				if (newItems.length == 3)
					iterItems.push(newItems);
				else
					recursor(newItems, cnt+1);
				cnt++;
			}
		};
		recursor(specItems, 0);
	} else { // no item search
		var specItems = [];
		for (i=0; i<parsed.items.length; i++) {
			var lvl = parsed.itemlevels[parsed.items[i]];
			specItems.push([parsed.items[i],
					lvl ? lvl : parsed.itemdefault]);
		}
		// Flesh out unspecified items
		while (specItems.length < 3)
			specItems.push(noItem);
		iterItems.push(specItems);
	}

	var levelWeight;
	if (parsed.search) {
		if (!parsed.levelweight) {
			switch (poke.role) {
			case Pokemon.ALLROUNDER:
			case Pokemon.ATTACKER:
			case Pokemon.SPEEDSTER:
				levelWeight = LEVEL_WEIGHT.high.slice();
				break;
			case Pokemon.DEFENDER:
			case Pokemon.SUPPORTER:
				levelWeight = LEVEL_WEIGHT.low.slice();
				break;
			}
		} else if (parsed.levelweight.indexOf(',') >= 0) {
			// parse CSV
			levelWeight = parsed.levelweight.split(',');
		} else {
			// look-up its word name and copy the array
			levelWeight = LEVEL_WEIGHT[parsed.levelweight].slice();
		}
		
		// since the level index starts at 1, store sum at 0 for conv
		var sum = 0;
		for (i=0; i<levelList.length; i++)
			sum+= levelWeight[levelList[i]-1];
		levelWeight.unshift(sum);
	}

	// Multiplex search parameters (NB: More multiplexing based on hints)
	var t, tables = [];
	for (var m1=0; m1<iterMoves[0].length; m1++) {
	for (var m2=0; m2<iterMoves[1].length; m2++) {
	var base = (parsed.sort.length == 0 ? null :
			calcTables(poke, levelList, [noItem,noItem,noItem],null,
				   [iterMoves[0][m1]-1,iterMoves[1][m2]-1],
				   levelWeight, parsed)[0]);
	for (i=0; i<iterItems.length; i++) {
		iterateEmblems(tables, base, poke, levelList, iterItems[i],
			       [iterMoves[0][m1]-1,iterMoves[1][m2]-1],
			       levelWeight, parsed);
	}
	}
	}

	return tables;
}

