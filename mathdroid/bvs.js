// Implemented by: odi@salestock.id
// Implementation date: 2015-08-28
// source: http://remkovanderzwaag.nl/blog/updated-adwords-script-budget-vs-spend-report



//------------------------------------------------
// Report on Budget vs Spend (Hybrid)
// Created by: Remko van der Zwaag & PDDS
// remkovanderzwaag.nl & pdds.nl
// More info: http://goo.gl/d0KVTd
// CHANGELOG
// 12-06-2014: Combined two separate scripts into one Hybrid version (for MCC and accounts)
// 12-02-2015: Added column Spend yesterday and empty columns with days
// 18-05-2015: Added logic to only check campaigns with a specific label
//------------------------------------------------

//var spreadsheetId = '1II-2WDZ0m3Y3lR4EvGlDIkTcrVY1fnzThabHz1B_BxU';                             // Google Spreadsheet with account info
var spreadsheetId = '1R6Q6n9g-I-xi4DDMMLeUNARcPro6sg0hYg8N-0sPg4E';
var prefillSpreadsheet = true;                                    // When set to true, gets all accounts from the MCC account
                                                                   // and automagically adds their name and id to the spreadsheet
                                                                   // Use once, doesn't check for existing records
                                                                   // switch back to false after use
                                                                   // PREFERABLY RUN USING PREVIEW (true), CHANGE TO false AND SAVE

var emailAddr = "odi@salestock.id";                        // Where you want the report sent, only works when
                                                                   // prefillSpreadsheet = false
var emailSubject = "Adwords spend report";                         // What the email should be titled
var onlyReportProblems = false;                                     // Email will only contain accounts with errors
var ignoreNoBudgetCampaigns = false;                                // Never show campaigns with a 0 budget
var alwaysReport = true;                                          // Send an email even if no accounts need to be reported on
                                                                   // For use in combination with the previous options
var addWeekCols = false;                                            // Add extra columns for the days of the week
var getYesterdayCosts = true;                                      // Also calculate the amount that was spent yesterday

// Report colors
var overspendColor = '#ffc7c1';
var underspendColor = '#fffec1';

// OBSOLETE - Skip campaign label
var skipLabel = 'Temp';

// These are default values. Values found in the spreadsheet for the account will supercede these.
var defaultBudget = 0;    // Budget for the month in the AdWords account default currency
var defaultOver = 0.1;    // The amount the current tally can go over the running target budget (incl. today) before a warning is sent
var defaultUnder = 0.1;   // The amount the current tally can be under the running target budget. Set to 0 to ignore
                          // both are decimals representing percent: 0.1 = 10%, 1 = 100%, etc

// ADVANCED!
// --------------------------------------------------------
// Map spreadsheet info to fields we need
// Here you can ajust what column translates to a property
// 0 = A, 1 = B, etc.
// We only work with the first sheet,
// and only look at the first 26 columns (A-Z)
// ONLY USE IF YOU WANT TO USE A DIFFERENT FORMAT THAN THAT
// CREATED BY THE prefillSpreadsheet OPTION!
function mapRowToInfo(row) {
  return {
    custId: row[1],
    cust: row[0],
    budget: row[2],
    labels: row[5].split(','),
    over: row[3],
    under: row[4]
  };
}

// PLEASE DON'T TOUCH BELOW THIS LINE

function main() {
  try {
    // Uses parallel execution. Is limited to 50 accounts by Google.
    if (prefillSpreadsheet) {
      MccApp.accounts()
        .withLimit(50)
        .executeInParallel("getSSAccountInfo","saveSSAccountInfo");
    } else {
      MccApp.accounts()
        .withIds(getSpreadsheetIds())
        .withLimit(50)
        .executeInParallel("processAccount", "processReports");
    }
  } catch (e) {
    processReport(processAccount());
  }
}

// Get account name and id
function getSSAccountInfo() {
  var result = {
    custId: AdWordsApp.currentAccount().getCustomerId(),
    cust: AdWordsApp.currentAccount().getName()
  };
  Logger.log(result);
  return JSON.stringify(result);
}

// Save account info to the spreadsheet
function saveSSAccountInfo(response) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (e) {
  }
  ss = ss.getSheets()[0];
  ss.appendRow(["Account Name", "Account ID", "Budget", "Overspend Ratio", "Underspend Ratio", "Campaign labels"]);
  for (var i in response) {
    if(!response[i].getReturnValue()) { continue; }
    var rep = JSON.parse(response[i].getReturnValue());
    Logger.log(rep);
    ss.appendRow([rep.cust, rep.custId]);
  }
}

function processAccount() {
  var multiAccountInfo = getAccountInfo(),
      currency = AdWordsApp.currentAccount().getCurrencyCode(),
      results = [];

  for (var i in multiAccountInfo) {
    var accountInfo = multiAccountInfo[i],
        accountId = accountInfo.custId,
        budget = accountInfo.budget,
        over = accountInfo.over,
        under = accountInfo.under,
        account = accountInfo.cust,
        labels = accountInfo.labels;

    var cost = 0,
        costYesterday = 0,
        date = new Date();

    // There is no good way to use the account's timezone
    // We use UTC, because it's close enough for use in Europe
    // The standard timezone is most likely PST

    // We adjust the current date so the amount of the day that
    // has past is taken into account when setting a target
    // Otherwise, running early in the day gives up to a day of
    // extra budget, even though there has been no opportunity to spend it.
    var today = date.getUTCDate() - (1 - date.getUTCHours()/23),
        days = 32 - new Date(date.getFullYear(), date.getMonth(), 32).getUTCDate();

    // This is a pretty naive way to plot this information
    // But unless your spending is significantly weighted within a month
    // it should be a decent predictor
    var partOfMonth = today/days,  // How far we are in the month
        maxInclTodayNoOver = partOfMonth * budget,      // The part of the budget allotted to the part of the month that has passed
        maxInclToday = maxInclTodayNoOver * (1 + over), // The amount of money that has to be spent to warrant a warning mail
        minInclToday = maxInclTodayNoOver * (1 - under);

    // Get the campaigns for your account
    // You can add some conditions here, to limit the accounts counted etc.
    var campaignIterator = AdWordsApp.campaigns();
    if (labels.length === 1 && labels[0] == '') {
      labels = [];
    }
    if (labels.length !== 0) {
      for (var j in labels) {
        labels[j] = '\'' + labels[j].trim() + '\''
      }
      campaignIterator = campaignIterator.withCondition("LabelNames CONTAINS_ANY [" + labels.join(', ') + "]");
    } else if (hasLabel(skipLabel)) {
      campaignIterator = campaignIterator.withCondition("LabelNames CONTAINS_NONE ['" + skipLabel + "']");
    }
    campaignIterator = campaignIterator.get();

    while (campaignIterator.hasNext()) {
      var campaign = campaignIterator.next();
      // We only look for costs made in the current month
      var stats = campaign.getStatsFor("THIS_MONTH");
      cost += stats.getCost();

      if (getYesterdayCosts) {
        var statsY = campaign.getStatsFor("YESTERDAY");
        costYesterday += statsY.getCost();
      }
    }

    var shoppingCampaignIterator = AdWordsApp.shoppingCampaigns().get();

    while (shoppingCampaignIterator.hasNext()) {
      var campaign = shoppingCampaignIterator.next();
      // We only look for costs made in the current month
      var stats = campaign.getStatsFor("THIS_MONTH");
      cost += stats.getCost();

      if (getYesterdayCosts) {
        var statsY = campaign.getStatsFor("YESTERDAY");
        costYesterday += statsY.getCost();
      }
    }

    var diff = 0;
    if (cost > maxInclToday) diff = 1;
    if (cost < minInclToday && under !== 0) diff = -1;

    var diffLabel = {
      '-1': 'Underspend',
      '0': 'Within margins',
      '1': 'Overspend'
    };

    var remainingBudget = budget - maxInclTodayNoOver,
        delta = cost - maxInclTodayNoOver,
        daysLeft = days - today;

    // Format results as an object. processReports decides what to do
    var result = {
      reportable: (diff !== 0),
      cust: account,
      custId: accountId,
      budget: fMoney(currency, budget),
      budgetInt: budget,
      diff: diff,
      status: diffLabel[diff],
      target: fMoney(currency, maxInclTodayNoOver),
      actual: fMoney(currency, cost),
      delta: fMoney(currency, delta) + ' (' + twoDecPerc(delta/maxInclTodayNoOver) + ')',
      recommend: fMoney(currency, ((budget - cost) / daysLeft)),
    };

    if (getYesterdayCosts) {
      result.yesterday = fMoney(currency, costYesterday);
    }

    if (addWeekCols) {
      result.wd_ma = ' ';
      result.wd_di = ' ';
      result.wd_wo = ' ';
      result.wd_do = ' ';
      result.wd_vr = ' ';
    }
    results.push(result);
  }

  return JSON.stringify(results);
}

function hasLabel(label) {
  return AdWordsApp.labels().withCondition("Name = '" + label + "'").
      get().hasNext();
}

// Process the results of a single
// Creates table, exports as html and sends to set emailaddress
function processReport(report) {
  // Define table(headers)
  var table = buildTable();
  rep = JSON.parse(report);
  for (var j in rep) {
    // Skip campaign if budget is 0 and ignoreNoBudgetCampaigns is on
    if (ignoreNoBudgetCampaigns && rep[j].budgetInt === 0) { continue; }
    // Only show records that have over/underspend if onlyReportProblems is true
    if (onlyReportProblems === false || rep[j].reportable === true) {
      var attrs = {};
      if (rep[j].diff === -1) { attrs.style = 'background-color: ' + underspendColor; }
      else if (rep[j].diff === 1) { attrs.style = 'background-color: ' + overspendColor; }
      add_row(table, rep[j], attrs);
    }
  }
  sendEmail(table);
}

// Process the results of all the accounts
// Creates table, exports as html and sends to set emailaddress
function processReports(reports) {
  // Define table(headers)
  var table = buildTable();
  for (var i in reports) {
    if(!reports[i].getReturnValue()) { continue; }
    var rep = JSON.parse(reports[i].getReturnValue());
    for (var j in rep) {
      // Skip campaign if budget is 0 and ignoreNoBudgetCampaigns is on
      if (ignoreNoBudgetCampaigns && rep[j].budgetInt === 0) { continue; }
      // Only show records that have over/underspend if onlyReportProblems is true
      if (onlyReportProblems === false || rep[j].reportable === true) {
        var attrs = {};
        if (rep[j].diff === -1) { attrs.style = 'background-color: ' + underspendColor; }
        else if (rep[j].diff === 1) { attrs.style = 'background-color: ' + overspendColor; }
        add_row(table, rep[j], attrs);
      }
    }
  }
  sendEmail(table);
}

function sendEmail(table) {
   // Only send if there is something to report, or alwaysReport is set.
  if (alwaysReport || table.rows.length > 0) {
    var htmlBody = '<' + 'h1>' + emailSubject + '<' + '/h1>' + render_table(table, {border: 1, width: "95%", style: "border-collapse:collapse;"});
    MailApp.sendEmail(emailAddr, emailSubject, emailSubject, { htmlBody: htmlBody });
  }
}

function buildTable() {
  var tableCols = {
    cust: 'Customer',
    custId: 'Customer-ID',
    budget: 'Budget',
    status: 'Status',
    target: 'Target spend',
    actual: 'Actual spend',
    delta: 'Delta',
    recommend: 'Recommended daily spend',
  };
  if (getYesterdayCosts) {
    tableCols.yesterday = 'Spend yesterday';
  }
  if (addWeekCols) {
    tableCols.wd_ma = 'Mo';
    tableCols.wd_di = 'Tu';
    tableCols.wd_wo = 'We';
    tableCols.wd_do = 'Th';
    tableCols.wd_vr = 'Fr';
  }
  return create_table(tableCols);
}

// Few formatting functions
function twoDec(i) {
  return parseFloat(i).toFixed(2);
}

function twoDecPerc(p) {
  return twoDec(p * 100) + '%';
}

function fMoney(currency, amount) {
  return currency + ' ' + twoDec(amount);
}

function getSpreadsheetIds() {
  var ids = [],
      ss,
      reAWId = /^([0-9]{3})-([0-9]{3})-([0-9]{4})$/;

  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (e) {
    return ids;
  }
  ss = ss.getSheets()[0];
  var rows = parseInt(ss.getLastRow());
  var range = ss.getRange("A1:Z" + rows).getValues();
  for (var i = 0; i < rows; i++) {
    var account = mapRowToInfo(range[i]);
    if (!reAWId.test(account.custId)) {
      continue;
    }
    ids.push(account.custId);
  }
  return ids;
}

// Fetch info for current account from the spreadsheet
// MCC scripts don't seem to support shared state between
// Parallel executions, so we need to do this fresh for every account

// Uses default info from 'defaults' set in script, and replaces with
// values from spreadsheet where possible
function getAccountInfo() {
  var ss;
  var reAWId = /^([0-9]{3})-([0-9]{3})-([0-9]{4})$/;
  var protoAccount = {
    custId: AdWordsApp.currentAccount().getCustomerId(),
    cust: AdWordsApp.currentAccount().getName(),
    budget: defaultBudget,
    labels: [],
    over: defaultOver,
    under: defaultUnder
  };

  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (e) {
    return [protoAccount];
  }
  ss = ss.getSheets()[0];
  var rows = parseInt(ss.getLastRow());
  var range = ss.getRange("A1:Z" + rows).getValues();
  var accounts = [];

  for (var i = 0; i < rows; i++) {
    var account = mapRowToInfo(range[i]);
    if (!reAWId.test(account.custId) || account.custId !== protoAccount.custId) {
      continue;
    }

    for(var key in account) {
      if (account[key] === '') {
        account[key] = protoAccount[key];
      }
    }
    accounts.push(account);
  }
  if (accounts.length === 0) {
    return [protoAccount];
  } else {
    return accounts;
  }
}

// Instantiate a table object with given column names
// Either as array or object/hash
function create_table(cols) {
  var table = { head: [], rows: [], row_attrs: [], row_names: undefined};
  if (cols instanceof Array) {
    table.head = cols;
  } else if (cols instanceof Object) {
    var i = 0;
    table.row_names = {};
    for (var key in cols) {
      table.head.push(cols[key]);
      table.row_names[key] = i;
      i++;
    }
  }
  return table;
}

// Add a row to the table object
// Either an clean array or an object
// with correct parameter names
function add_row(table, row, attrs) {
  if (row instanceof Array) {
    table.rows.push(row);
    return;
  }
  if (table.row_names === undefined) {
    return;
  }
  var new_row = [];
  for (var key in row) {
    if (table.row_names[key] === undefined) {
      continue;
    }
    new_row[table.row_names[key]] = row[key];
  }
  table.rows.push(new_row);
  table.row_attrs.push(attrs);
}

// Log the contents of the table object in a semi readable format
function log_table(table) {
  Logger.log('----------------------------------');
  Logger.log(table.head.join(' | '));
  Logger.log('----------------------------------');
  for (var i in table.rows) {
    Logger.log(table.rows[i].join(' | '));
  }
  Logger.log('----------------------------------');
}

// Turn the table object into an HTML table
// Add attributes to the table tag with the attrs param
// Takes an object/hash
function render_table(table, attrs) {
  function render_tag(content, tag_name, attrs) {
    var attrs_str = '';
    if (attrs instanceof Object) {
      for (var attr in attrs) {
        attrs_str += [' ',attr,'="', attrs[attr], '"'].join('');
      }
    }
    var tag = ['<' + tag_name + attrs_str + '>'];
    tag.push(content);
    tag.push('<!--' + tag_name + '-->');
    return tag.join('');
  }
  function render_row(row, field, row_attrs) {
    if (field === undefined) {
      field = 'td';
    }
    var row_ar = new Array(table.head.length);
    for (var col in row) {
      row_ar.push(render_tag(row[col], field, row_attrs));
    }
    return render_tag(row_ar.join(''), 'tr');
  }
  var table_ar = [];
  table_ar.push(render_row(table.head, 'th'));
  for (var row in table.rows) {
    table_ar.push(render_row(table.rows[row], 'td', table.row_attrs[row]));
  }
  return render_tag(table_ar.join(''), 'table', attrs);
}
