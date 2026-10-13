//<nowiki>
// משתמש:גאון הירדן/בדיקת מילים חשודות.js - סקריפט הייבוא והעדכון. בדיקת המילים עברה לגאדג'ט wikitextWordCheck (word-filter/site/, README).
mw.loader
  .using([
    "mediawiki.api",
    "mediawiki.ForeignApi",
    "mediawiki.util",
    "oojs-ui-windows",
    "oojs-ui-core",
    "ext.gadget.mw-import",
  ])
  .then(() => {
    mw.messages.set({
      "": "הערות לבדיקה:",
      "checkty-whait-title": "ממתין לתוצאות הבדיקה...",
      "update-success": "העדכון או הייבוא הסתיים בהצלחה! ",
      images: "לא לשכוח לבדוק תמונות!",
      "no-images": "אין תמונות בערך זה.",
      "checkty-page-doesnt-exist": " (הדף אינו קיים)",
      aspaklaria: "הערך עבר סינון! העדכון מוגבל לעורכי אספקלריה בלבד.",
      block: "הייבוא או העדכון נחסם על ידי ספק הרשת",
    });
    const api = new mw.Api();
    const isUpdate = mw.config.get("wgArticleId") > 0;
    const isOpennigPage = mw.config.get("aspaklaryaLockdown") === "edit-full";
    const Template = /(\{\{מיון ויקיפדיה\|דף=)(.*)(\|גרסה=)(\d*)/;
    const edited =
      /\{\{(נערך במכלול|נבמ)\}\}|\[\[קטגוריה:המכלול: ערכים ששוכתבו או הורחבו במכלול\]\]/;
    const sectionParam = mw.util.getParamValue("section");
    const isSection =
      sectionParam && sectionParam !== "0" ? sectionParam : null;
    const textBox = $("#wpTextbox1");
    const summaryBox = $("#wpSummary");
    const updatemassage = $("<div>", { text: mw.msg("update-success") });
    const noimages = $("<div>", { text: mw.msg("no-images") });
    const images = $("<div>", { text: mw.msg("images") });
    const setOf =
      "<div><span>" +
      '<input type="checkbox" id="tionary" name="tionary">' +
      '<label for="tionary"> בוט ייבוא</label></span>' +
      '<span><select id="selectbut" disabled>' +
      '<option value="" selected disabled hidden>בחר סיווג...</option>' +
      '<option value="ספורט">ספורט</option>' +
      '<option value="סרטים">סרטים</option>' +
      '<option value="טלוויזיה">טלוויזיה</option>' +
      '<option value="שחקנים">שחקנים</option>' +
      '<option value="שירים">שירים</option>' +
      '<option value="מוזיקה">מוזיקה</option>' +
      '<option value="מוזיקאים">מוזיקאים</option>' +
      '<option value="ספרות">ספרות</option>' +
      '<option value="סופרים">סופרים</option>' +
      '<option value="תרבות ובידור">תרבות ובידור</option>' +
      //'<option value="אלבומים">אלבומים</option>' +
      //'<option value="משחקי מחשב">משחקי מחשב</option>' +
      "</select></div>";

    let PageName = mw.config.get("wgPageName");
    if (isUpdate) {
      PageName = PageName.replace(/^רבי_/, "")
        .replace(/^הרב_/, "")
        .replace(/_/g, " ")
        .replace(/ה"קדושה"/g, "הקדושה")
        .replace(/ה"קדוש"/g, "הקדוש")
        .replace(/ה"קדושים"/g, "הקדושים")
        .replace(/א-ל/g, "אל")
        .replace("המכלול:", "ויקיפדיה:");
    } else {
      PageName = PageName.replace(/_/g, " ");
    }
    if ($("#wikiPageName").length > 0) {
      PageName = $("#wikiPageName").text();
    }
    if (
      mw.config.get("wgAction") === "edit" ||
      mw.config.get("wgAction") === "submit"
    ) {
      $("#mw-editpage-watch").before(setOf);
      $("#tionary").on("change", function () {
        $("#selectbut").prop("disabled", !this.checked);
      });
      if (
        textBox &&
        Template.exec(textBox.val()) &&
        Template.exec(textBox.val())[4] != null
      ) {
        PageName = Template.exec(textBox.val())[2];
      }
    }
    const parseParams = {
      page: PageName,
      exist: isUpdate && !isOpennigPage,
      currentPage: mw.config.get("wgPageName"),
    };

    const level = getLevel(mw.config.get("wgUserGroups"));
    function getLevel(groupsUesr) {
      return groupsUesr.indexOf("sysop") !== -1
        ? 20
        : groupsUesr.indexOf("bot") !== -1
        ? 18
        : groupsUesr.indexOf("aspaklarya2") !== -1
        ? 16
        : groupsUesr.indexOf("aspaklaryaEditor") !== -1
        ? 14
        : groupsUesr.indexOf("patroller") !== -1
        ? 12
        : groupsUesr.indexOf("wikiupdate") !== -1
        ? 10
        : groupsUesr.indexOf("wikimport") !== -1
        ? 8
        : 0;
    }

    const ApiParse = new mw.import();
    const ForeignApi = new mw.ForeignApi(ApiParse.urlImport, { anonymous: true });

    function checkifexist() {
      ForeignApi.get({
        titles: PageName,
      }).done((result) => {
        if (result && result.query && result.query.pages) {
          if (result.query.pages["-1"]) {
            console.log("הדף לא קיים בוויקיפדיה העברית");
          } else {
            const stringButton = (isUpdate && !isOpennigPage) ? "עדכון" : "ייבוא";
            const Btn1 = new OO.ui.ButtonInputWidget({
              label: stringButton,
              title: stringButton,
              id: "wpImportWidget",
            });
            if (isUpdate && !isOpennigPage) {
              if (level < 10) return;
            } else {
              if (level > 15 && mw.config.get("wgAction") === "edit") {
                const apiToCheck = `${ApiParse.urlImport}?action=parse&page=${encodeURIComponent(
                  PageName
                )}&format=json&prop=text&section=0&origin=*`;

                fetch(apiToCheck)
                  .then((response) => response.json())
                  .then(({ parse }) => {
                    if (parse) {
                      const { text } = parse;
                      const rawa = text["*"].replace("/wiki/", "/");
                      const box3 = $($.parseHTML(rawa));
                      const box2 = $(
                        '<div class="warningbox mw-warning-with-logexcerpt mw-content-rtl" dir="rtl" lang="he"></div>'
                      ).html(box3);
                      $(
                        "#mw-content-text > div.mw-newarticletext.plainlinks"
                      ).html(box2);
                    }
                  });
              }
            }
            if (level > 7) {
              $("#wpDiffWidget").after(
                Btn1.$element.click(async () => {
                  if (isUpdate) {
                    const history = await getHistory();
                    displayDataEdits(history);
                  } else {
                    getArticle();
                  }
                })
              );
            }
          }
        }
      });
    }
    function getArticle() {
      // Create results container if not exists
      if (!$("#checktyResults").length) {
        $(".editButtons").after(`
          <div id="checktyResults">
            <div class="checktyResultsTitle">פינת ההודעות</div>
          </div>
        `);
      }

      // Check for previous edits
      if (edited.test(textBox.val())) {
        alert("ערך זה נערך במכלול! נא לשמר עריכות מקומיות.");
      }

      // Process form parameters
      const isShort = document.getElementById("tionary")?.checked === true;
      const select = document.getElementById("selectbut")?.value;

      if (isShort) {
        parseParams.bot = select;
      }

      if (isSection && isUpdate) {
        parseParams.sectionNum = isSection;
        parseParams.sectionTitle = summaryBox.val().replace(/\/|\*/g, "");
      }

      // Fire import hooks and process API call
      mw.hook("userjs.import.starttingImport").fire(parseParams);

      ApiParse.importWikitext(parseParams)
        .then((result) => {
          if (!result) return;

          if (parseParams.form) {
            return ApiParse.openForm(
              parseParams.page,
              result.text,
              result.summary,
              parseParams.exist,
              parseParams.section
            );
          }

          // Reset parameters
          Object.assign(parseParams, {
            sectionTitle: null,
            sectionNum: undefined,
            form: false,
            bot: false,
          });

          mw.hook("userjs.import.gettingData").fire(result);

          if (!textBox) return;

          // Update text and summary
          textBox.val(result.text);
          mw.hook("userjs.import.loadTextForBox").fire(result.text);
          summaryBox.val(result.summary);

          // Add change tags
          const changeTag = (isUpdate && !isOpennigPage) ? "update" : "wikiimport";
          const elm = $("#editform input[name=wpChangeTags]");

          if (elm.length === 0) {
            $("#editform").append(
              `<input type="hidden" name="wpChangeTags" value="${changeTag}">`
            );
          } else {
            elm.val(`${elm.val()},${changeTag}`);
          }

          writeMsg(updatemassage, "check");
          check();
        })
        .catch((error) => {
          console.error(error);
          mw.notify(error, { type: "warn" });
        });
    }
    // בדיקת המילים - הגאדג'ט המשותף wikitextWordCheck (מדיה ויקי:Gadget-wikitextWordCheck.js):
    // אותו מנוע ואותן רשימות כמו הסריקה של הדשבורד. מחליף את הבדיקה לפי "המכלול:בודק מילים חשודות".
    function check() {
      if (!$("#checktyResults").length)
        $(".editButtons").after(
          '<div id="checktyResults"><div class="checktyResultsTitle">הערות לבדיקה</div></div>'
        );
      const pic =
        /(jpg|pdf|ogg|webm|png|jpeg|Jpg|JPG|svg|svg\.png|gif|gallery)/;
      if (pic.test(textBox.val())) {
        writeMsg(images, "alert");
      } else {
        writeMsg(noimages, "check");
      }
      mw.loader
        .using("ext.gadget.wikitextWordCheck")
        .then(() => mw.wikitextWordCheck.run());
    }
    function writeMsg(msg, icon) {
      var x;
      if (msg instanceof Array) {
        if (msg.length === 0) return;
        msg = "<div>" + msg.join("<br/>") + "</div>";
      }
      x = $(msg).css("display", "none").addClass("checktyMsg");
      if (icon) {
        var iconWidget = new OO.ui.IconWidget({
          icon: icon,
        });
        x.prepend(iconWidget.$element);
      }
      $("#checktyResults").append(x);
      x.show("slow");
      return x;
    }
    async function getHistory() {
      if (!$("#checktyResults").length) {
        $(".editButtons").after(
          '<div id="checktyResults"><div class="checktyResultsTitle">פינת ההודעות</div></div>'
        );
      }

      const localpagename = mw.config.get("wgPageName");
      const params = {
        prop: "info|revisions",
        indexpageids: true,
        titles: localpagename,
        utf8: 1,
        rvprop: "ids|timestamp|flags|comment|user|size|tags",
        rvdir: "newer",
        rvlimit: "max",
      };

      try {
        const data = await api.get(params);
        const revisions = data.query.pages[data.query.pageids[0]].revisions;
        if (!revisions) return;

        return analyzeRevisions(revisions);
      } catch (error) {
        console.error("Error fetching history:", error);
      }
    }

    function analyzeRevisions(revisions) {
      return revisions.reduce(
        (acc, rev, index, array) => {
          const comment = rev.comment;
          const size = rev.size;

          if (index > 0) {
            const prevSize = array[index - 1].size;
            const diff = size - prevSize;

            if (!/מוויקיפדיה|מויקיפדיה|החלפת טקסט/.test(comment)) {
              acc.edits++;
              acc.plussize += diff;
            } else {
              acc.wikiup += diff;
            }
          }

          if (/הסרת תוכן|גיור מונח/.test(comment)) {
            acc.aspak.push({ תקציר: comment });
          }

          if (/הסרת תמונה|החלפת תמונה|תמונה חילופית|, תמונה/.test(comment)) {
            acc.potos.push({ תקציר: comment });
          }

          if (/החלפות אוטומטיות/.test(comment)) {
            acc.autoReplace.push({ תקציר: comment });
          }

          return acc;
        },
        {
          edits: 0,
          plussize: 0,
          wikiup: 0,
          aspak: [],
          potos: [],
          autoReplace: [],
        }
      );
    }

    function displayDataEdits(stats) {
      const { edits, plussize, wikiup, aspak, potos, autoReplace } = stats;

      if (plussize !== 0) {
        writeMsg(
          $("<div>").text(
            `ערך זה נערך במכלול ${edits} פעמים. גודל העריכות המקומיות המשוקלל הוא: ${plussize} בתים`
          )
        );
      }

      if (!aspak.length) {
        getArticle();
      } else if (level >= 10) {
        writeMsg($("<div>").text("הערך עבר סינון תוכן!"), "alert");
        getArticle();
      } else {
        writeMsg($("<div>").text(mw.msg("aspaklaria")), "alert");
      }

      if (potos.length) {
        writeMsg($("<div>").text("הערך עבר טיפול בתמונות!"), "alert");
      }

      if (autoReplace.length) {
        writeMsg($("<div>").text("הערך עבר החלפות סינון אוטומטיות"), "alert");
      }
    }

    if ($.inArray(mw.config.get("wgAction"), ["edit", "submit"]) + 1)
      $(function () {
        if (
          $.inArray(mw.config.get("wgNamespaceNumber"), ["2", "3", "4", "6"]) +
          1
        ) {
          return;
        }
        if (location.href.indexOf("&submit") === -1) {
          checkifexist();
        }
        // צביעת המילים בתצוגה המקדימה ובהבדלים - בכפתור "בדיקת מילים" של הגאדג'ט.
        // כאן נשאר רק הכלי להחזרת שורות שנמחקו בטבלת ההבדלים.
        if (document.querySelector(".previewnote") !== null) return;
        const btn = $('<button id="editDiffrents">תצוגת הבדלים מתקדמת</button>');
        btn.on("click", function () {
          importScript("משתמש:בוט גאון הירדן/ספירת העומר.js");
        });
        $("#bodyContent").prepend(btn);
      });

    function alertDataEdits(data) {
      const { edits, plussize, wikiup, aspak, potos } = data;
      if (!aspak.length && !potos.length) {
        return getArticle();
      }
      const container = $("<div>");
      const msg = mw.util.messageBox(
        `הערך נערך במכלול ${edits} פעמים. גודל העריכות המקומיות המשוקלל הוא : ${plussize} בתים `,
        "info"
      );

      let warnText = "";
      if (aspak.length && potos.length) {
        warnText = "הערך עבר סינון תוכן ותמונות!";
      } else if (aspak.length) {
        warnText = "הערך עבר סינון תוכן!";
      } else if (potos.length) {
        warnText = "שים לב, הערך עבר טיפול בתמונות!";
      }
      if (warnText.length) {
        warnText = warnText;
      }

      const warnBox = mw.util.messageBox(warnText, "warning");
      /*$(".vector-body-before-content").append(msg, boxMassags); */
      container.append(warnBox, msg);
      OO.ui
        .alert(container, {
          title: "עריכות מקומיות",
          actions: [
            {
              action: "accept",
              label: "אישור",
              flags: "primary",
            },
          ],
        })
        .done(() => {
          /*
          if (aspak.length && level < 14) {
            return;
          } else {*/
          return getArticle();
          //}
        });
    }

    if (
      mw.config.get("wgPageName") != "עמוד_ראשי" &&
      mw.config.get("wgPageContentModel") != "flow-board" &&
      (mw.config.get("wgNamespaceNumber") === 0 ||
        mw.config.get("wgNamespaceNumber") === 10) &&
      level > 9 &&
      mw.config.get("wgAction") === "view"
    ) {
      var btnUpDate = mw.util.addPortletLink(
        "p-views",
        "#",
        "עדכון",
        "wikiUpdate",
        null,
        null,
        "#ca-history"
      ); //הפרמטר הרביעי מיועד לצורך הסתרה בקוד הסינון בקומונס
      $(btnUpDate).click(async function () {
        const aspSpecLinks = {
          sport: "ספורט",
          musicion: "מוזיקאים",
          music: "מוזיקה",
          player: "שחקנים",
          television: "טלוויזיה",
          sofrim: "סופרים",
          singers: "זמרים",
          movie: "קולנוע",
          books: "ספרות",
          gaming: "משחקי מחשב",
          balet: "בלט",
          tarbut: "תרבות ובידור",
          albums: "אלבומים",
          film: "סרטים",
          songs: "שירים",
        };
        if ($("#wikiPageName").length > 0) {
          parseParams.page = $("#wikiPageName").text();
        }
        parseParams.form = true;
        const bot = $("#asp-measege").text();
        if (bot) parseParams.bot = aspSpecLinks[bot];
        const history = await getHistory();
        alertDataEdits(history);
      });
      $("div.mw-heading").each(function (i) {
    	const heading = $(this).find("h2, h3").text();
    	const editSection = $(this).find(".mw-editsection");

    	editSection
        	.find("a:not(.mw-editsection-visualeditor)")
        	.after(
            	$("<span> | </span>"),
            	$("<a>", {
                	id: i,
                	class: "updatesection",
                	text: "עדכון",
                	href: "#",
                	"data-title": heading,
        	    })
    	    );
		});
      $(".updatesection").click(async function () {
        parseParams.sectionNum = $(this).attr("id");
        parseParams.sectionTitle = $(this).attr("data-title");
        parseParams.form = true;
        const history = await getHistory();
        alertDataEdits(history);
      });
    }
    const tagsElement = $('#editform input[name="wpChangeTags"]');
    if (
      /עדכון (פסקה )?מוויקיפדיה|ייבוא מוויקיפדיה העברית/.test(summaryBox.val())
    ) {
      if (!tagsElement[0]) {
        $("#editform").append(
          `<input type="hidden" name="wpChangeTags" value="${
            /עדכון/.test(summaryBox.val()) ? "update" : "wikiimport"
          }">`
        );
      }
    }
  });
//</nowiki>