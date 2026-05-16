async function loadScheduled(){

    const response =
    await fetch("/scheduled");

    const posts =
    await response.json();

    const box =
    document.getElementById(
        "scheduled"
    );

    box.innerHTML =
    `<div class="grid"></div>`;

    const grid =
    box.querySelector(".grid");

    posts.forEach(post=>{

        grid.innerHTML += `

        <div class="card">

            <img src="${post.image}">

            <h2>${post.client}</h2>

            <p>${post.platform}</p>

            <p>${post.caption}</p>

            <p>${post.scheduleDate}</p>

            <p>${post.status}</p>

        </div>

        `;
    });
}

loadScheduled();

setInterval(
    loadScheduled,
    5000
);